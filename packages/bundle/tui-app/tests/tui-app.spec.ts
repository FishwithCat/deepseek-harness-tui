/**
 * The terminal application over the real registries and a scripted Agent
 * factory: composer routing, live rendering, modal answers, and exit.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmModelReasoningInfo, LlmResolvedModelInfo, ModelModality, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import UserApprovalService from '@deepseek-ai/dsh-user-approval'
import { TuiApp, internals, reservesCtrlV } from '../src/app.ts'
import type { ClipboardImage } from '../src/clipboard.ts'
import { apply, inject, name, TUI_STARTUP_SERVICE } from '../src/index.ts'
import type { Config } from '../src/config.ts'
import { FakeTerminal } from './support/fake-terminal.ts'

/** A two-by-two PNG; the mounted attachment store decodes and admits real bytes. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwH4QZYAwAR8oH+Xm0fdIAAAAASUVORK5CYII='

const originalInternals = { ...internals }
const contexts: Context[] = []
const homes: string[] = []

afterEach(async () => {
  Object.assign(internals, originalInternals)
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

/** One scripted prompt reaction. */
interface Script {
  afterPrompt(session: Agent['session'], message: UserMessage): Promise<void> | void
}

/** An adapter over one exact route's catalog, declared modalities, and reasoning efforts. */
class ScriptedAdapter extends LlmAdapter {
  /**
   * @param models - the advertised catalog; empty means the provider advertises nothing.
   * @param modalities - the declared image capability; undefined means unknown.
   * @param reasoning - the declared reasoning efforts; undefined means the route has none.
   */
  constructor(
    private readonly models: readonly LlmModelInfo[],
    private readonly modalities: readonly ModelModality[] | undefined,
    private readonly reasoning: LlmModelReasoningInfo | undefined,
  ) {
    super()
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models.filter(model => model.provider === provider))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.modalities === undefined ? {} : { inputModalities: this.modalities },
      ...this.reasoning === undefined ? {} : { reasoning: this.reasoning },
    })
  }

  override stream(): AsyncIterable<StreamChunk> {
    return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('unused adapter stream')) }) }
  }
}

/**
 * The DeepSeek-shaped effort set used by the effort tests.
 * @returns declared efforts whose default is `high`.
 */
function effortInfo(): LlmModelReasoningInfo {
  return {
    efforts: [
      { id: ReasoningEffortId('off'), name: 'Off' },
      { id: ReasoningEffortId('low'), name: 'Low' },
      { id: ReasoningEffortId('high'), name: 'High' },
    ],
    defaultEffort: ReasoningEffortId('high'),
  }
}

/** The booted fixture: the app, its terminal, and the observed process facts. */
interface Fixture {
  ctx: Context
  terminal: FakeTerminal
  app: TuiApp
  exits: number[]
  /** Prompts the app queued as their own turns. */
  submitted: UserMessage[]
  /** Steering content the app handed the running turn. */
  steered: UserMessage[]
  /** Cancellation requests the scripted Agent received. */
  cancelled(): number
  /** Flip the scripted Agent's lifecycle status. */
  setRunning(value: boolean): void
}

/**
 * Remove ANSI escape sequences from captured terminal output.
 * @param text - raw terminal bytes.
 * @returns the visible text.
 */
function plain(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
}

/**
 * The frame the alternate-screen renderer last composited, with styles removed.
 * @param app - the running application.
 * @returns one entry per terminal row.
 */
function screen(app: TuiApp): string[] {
  // The renderer owns its composited rows, and the written byte stream alone
  // does not say what a terminal ends up showing; the layout tests read the
  // frame the renderer keeps for its own differential repaints.
  const renderer = (app as unknown as { tui: { previousScreen: string[] } }).tui
  return renderer.previousScreen.map(line => plain(line).replaceAll('\u001b]8;;\u0007', ''))
}

/**
 * Boot the app over the real registries and a scripted Agent factory.
 * @param script - how the scripted Agent reacts to a prompt.
 * @param options - screen mode plus the optional measurement, compaction, attachment, plan-mode, and adapter rows.
 * @returns the running fixture.
 */
async function bench(
  script: Script,
  options: {
    screen?: Config['screen']
    tokenMeter?: boolean
    compaction?: boolean
    projections?: boolean
    attachments?: boolean
    planMode?: boolean
    models?: readonly LlmModelInfo[]
    modalities?: readonly ModelModality[]
    reasoning?: LlmModelReasoningInfo
  } = {},
): Promise<Fixture> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  if (options.projections !== false) await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  await ctx.plugin(LlmRuntime)
  if (options.planMode === true) {
    // `set()` folds the turn boundary to decide commit-versus-queue; the loop
    // itself is not mounted because the scripted Agent owns the lifecycle.
    ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(PlanModeController, { section: 'Test plan mode instructions.' })
  }
  if (options.models !== undefined || options.modalities !== undefined || options.reasoning !== undefined) {
    ctx.llm.registerAdapter(['test-provider'], new ScriptedAdapter(options.models ?? [], options.modalities, options.reasoning))
  }
  if (options.attachments === true) {
    const home = await mkdtemp(join(tmpdir(), 'dsh-tui-attachments-'))
    homes.push(home)
    await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  }
  if (options.tokenMeter === true || options.compaction === true) await ctx.plugin(TokenMeter)
  if (options.compaction === true) await ctx.plugin(BasicCompactionEngine, { auto: true })
  await ctx.plugin(UserApprovalService, { policy: 'ask' })
  const exits: number[] = []
  const submitted: UserMessage[] = []
  const steered: UserMessage[] = []
  const observed = { cancelled: 0, running: false }
  ctx.agents.setFactory({
    async createAgent(ownerCtx: Context, createOptions: CreateAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.create(createOptions.sessionId)
      const inbox = createInboxStub()
      let idle = Promise.resolve()
      const agent: Agent = {
        id: session.id,
        options: createOptions.agentOptions ?? {},
        session,
        inbox,
        get status() { return observed.running ? 'running' : 'idle' },
        ctx: ownerCtx,
        cancel: () => { observed.cancelled += 1 },
        runMaintenance: () => Promise.reject(new Error('not used')),
        send: () => {},
        followup: (message: UserMessage) => {
          submitted.push(message)
          agent.inbox.append('next-turn', message)
          idle = Promise.resolve().then(() => script.afterPrompt(session, message))
        },
        steer: (message: UserMessage) => { steered.push(message) },
        inject: () => {},
        whenIdle: () => idle,
      }
      await createOptions.setup?.(ownerCtx, agent)
      ctx.agents.register(agent)
      return { agent, dispose: () => Promise.resolve() }
    },
    resume: () => Promise.reject(new Error('not used')),
  })
  ctx.provide('appExit', (code: number) => { exits.push(code) })
  const terminal = new FakeTerminal()
  internals.isInteractive = () => true
  internals.createTerminal = () => terminal
  const app = await TuiApp.boot({
    ctx,
    config: { screen: options.screen ?? 'inline' },
    cwd: process.cwd(),
    invocation: {},
    exit: (code: number) => { exits.push(code) },
  })
  return {
    ctx,
    terminal,
    app,
    exits,
    submitted,
    steered,
    cancelled: () => observed.cancelled,
    setRunning: (value: boolean) => { observed.running = value },
  }
}

/** Append one complete answered turn to a session. */
function appendAnsweredTurn(session: Agent['session'], message: UserMessage, reply: string): void {
  const turn = session.seq + 1
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    stream: [],
    message: createAssistantMessage({
      content: [{ type: 'text', text: reply }],
      source: { provider: 'test-provider', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('TuiApp', () => {
  it('submits a composer line to the Agent and renders the durable reply', async () => {
    const test = await bench({
      afterPrompt(session, message) {
        appendAnsweredTurn(session, message, 'the answer is 42')
      },
    })
    test.terminal.feed('what is the answer?')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(test.terminal.output).toContain('the answer is 42') })
    expect(test.terminal.output).toContain('what is the answer?')
    await test.app.stop(0)
  })

  it('lists commands for /help and reports an unknown command', async () => {
    const test = await bench({ afterPrompt: () => {} })
    test.terminal.feed('/help')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(test.terminal.output).toContain('/quit') })
    expect(plain(test.terminal.output)).toContain('/effort')
    test.terminal.feed('/definitely-not-a-command')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(test.terminal.output).toContain('unknown command') })
    await test.app.stop(0)
  })

  it('switches the model route from the picker, and applies nothing when it is dismissed', async () => {
    const test = await bench({ afterPrompt: () => {} }, {
      screen: 'alternate',
      models: [{ provider: 'test-provider', id: 'other-model', name: 'Other Model' }],
    })
    test.terminal.feed('/model')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('Select a model') })
    test.terminal.feed('\x1b')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('Select a model'))).toBe(false)
    })
    test.terminal.feed('/model')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('Select a model'))).toBe(true)
    })
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('model set to test-provider/other-model')
    })
    await test.app.stop(0)
  })

  it('switches the model route from the command input and rejects a malformed one', async () => {
    const test = await bench({ afterPrompt: () => {} }, { models: [] })
    test.terminal.feed('/model test-provider/other-model')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('model set to test-provider/other-model')
    })
    test.terminal.feed('/model malformed')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('expected <provider>/<model>, got "malformed"')
    })
    await test.app.stop(0)
  })

  it('switches reasoning effort from the picker and reports it in the footer', async () => {
    const test = await bench({ afterPrompt: () => {} }, { reasoning: effortInfo() })
    test.terminal.feed('/effort')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('Select reasoning effort') })
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('reasoning effort set to off') })
    expect(plain(test.terminal.output)).toContain('test-model • off')
    await test.app.stop(0)
  })

  it('leaves the effort unchanged when the picker is dismissed', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate', reasoning: effortInfo() })
    test.terminal.feed('/effort')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('Select reasoning effort') })
    test.terminal.feed('\x1b')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('Select reasoning effort'))).toBe(false)
    })
    expect(plain(test.terminal.output)).not.toContain('reasoning effort set to')
    await test.app.stop(0)
  })

  it('switches reasoning effort from the command input and rejects an unknown one', async () => {
    const test = await bench({ afterPrompt: () => {} }, { reasoning: effortInfo() })
    test.terminal.feed('/effort low')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('reasoning effort set to low') })
    test.terminal.feed('/effort nope')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('expected one of off, low, high') })
    await test.app.stop(0)
  })

  it('reports a route that declares no reasoning effort', async () => {
    const test = await bench({ afterPrompt: () => {} }, { modalities: ['text'] })
    test.terminal.feed('/effort')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('test-provider/test-model declares no reasoning effort')
    })
    await test.app.stop(0)
  })

  it('clears back to the provider default when the route declares no default effort', async () => {
    const info = effortInfo()
    const test = await bench({ afterPrompt: () => {} }, { reasoning: { efforts: info.efforts } })
    test.terminal.feed('/effort high')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('reasoning effort set to high') })
    test.terminal.feed('/effort nope')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('expected one of off, low, high,') })
    test.terminal.feed('/effort')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('Provider default') })
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('reasoning effort set to the provider default')
    })
    await test.app.stop(0)
  })

  it('cancels a running turn on Ctrl+C and exits on /quit', async () => {
    const test = await bench({ afterPrompt: () => {} })
    test.setRunning(true)
    test.terminal.feed('\x03')
    await vi.waitFor(() => { expect(test.cancelled()).toBe(1) })
    await vi.waitFor(() => { expect(test.terminal.output).toContain('cancelling') })
    await test.app.stop(0)
    expect(test.exits).toEqual([0])
  })

  it('answers an approval request through the modal list', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const agent = test.ctx.agents.list()[0]!
    agent.session.append('turn/start', { turn: 1 })
    const decision = test.ctx.approval.request({ agent, toolName: 'bash', reason: 'needs the workspace' })
    await vi.waitFor(() => { expect(test.terminal.output).toContain('Allow bash?') })
    test.terminal.feed('\r')
    await expect(decision).resolves.toBe('allowed-once')
    await test.app.stop(0)
  })

  it('mounts the alternate-screen layout without a prompt', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate' })
    expect(test.terminal.output).toContain('\x1b[?1049h')
    await test.app.stop(0)
    expect(test.exits).toEqual([0])
  })

  it('shows a modal picker as plain rows above the composer, without the transcript showing through', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate' })
    for (let index = 0; index < 3; index += 1) {
      test.terminal.feed('/help')
      test.terminal.feed('\r')
    }
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('/quit') })
    const pending = test.app.choose('Select a model', [
      { value: 'deepseek-official/deepseek-flash', label: 'deepseek-official/deepseek-flash', description: 'DeepSeek-V4-Flash' },
    ])
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('Select a model') })
    const rows = screen(test.app)
    const title = rows.findIndex(row => row.trim() === 'Select a model')
    expect(title).toBeGreaterThan(-1)
    // The panel owns its rows: no transcript text survives beside or between them.
    for (const row of rows.slice(title, title + 3)) {
      expect(row).not.toContain('/help')
      expect(row).not.toContain('List available commands')
    }
    expect(rows[title]).toBe('Select a model'.padEnd(test.terminal.columns))
    // It sits as the transcript's next lines, directly above the composer.
    const composer = rows.findIndex(row => row.includes('Enter send'))
    expect(composer).toBeGreaterThan(title + 3)
    expect(rows[composer - 1]).toMatch(/^─+$/)
    expect(rows[title + 3]).toBe(rows[composer - 1])
    test.terminal.feed('\r')
    await expect(pending).resolves.toMatchObject({ value: 'deepseek-official/deepseek-flash' })
    await test.app.stop(0)
  })

  it('shows a long model route in full instead of shortening the value column', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate' })
    const route = 'deepseek-official/deepseek-v4-flash-vision-exp'
    const pending = test.app.choose('Select a model', [
      { value: route, label: route, description: 'DeepSeek-V4-Flash-Vision-Exp' },
    ])
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('Select a model') })
    const rendered = screen(test.app).join('\n')
    expect(rendered).toContain(`→ ${route}`)
    expect(rendered).toContain('DeepSeek-V4-Flash-Vision-Exp')
    test.terminal.feed('\r')
    await expect(pending).resolves.toMatchObject({ value: route })
    await test.app.stop(0)
  })

  it('scrolls a picker longer than the panel budget inside the panel', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate' })
    const items = Array.from({ length: 20 }, (_, index) => ({
      value: `model-${String(index)}`,
      label: `model-${String(index)}`,
      description: `Model ${String(index)}`,
    }))
    const pending = test.app.choose('Select a model', items)
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('Select a model') })
    const rows = screen(test.app)
    const title = rows.findIndex(row => row.trim() === 'Select a model')
    expect(rows[title + 2]).toContain('model-0')
    expect(rows.join('\n')).toContain('(1/20)')
    // The budget shows ten items and scrolls the rest, with the panel still
    // ending on the composer's top border.
    expect(rows.filter(row => /model-\d/.test(row))).toHaveLength(10)
    const composer = rows.findIndex(row => row.includes('Enter send'))
    const lastModel = rows.findLastIndex(row => /model-\d/.test(row))
    expect(rows[lastModel + 1]).toContain('(1/20)')
    expect(rows[lastModel + 2]).toBe(rows[composer - 1])
    test.terminal.feed('\r')
    await expect(pending).resolves.toMatchObject({ value: 'model-0' })
    await test.app.stop(0)
  })

  it('reports context occupancy and the automatic policy in the footer', async () => {
    const test = await bench({ afterPrompt: () => {} }, { tokenMeter: true, compaction: true })
    const session = test.ctx.agents.list()[0]!.session
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/context', { provider: 'test-provider', model: 'test-model', contextWindow: 262_144 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      stream: [],
      usage: { inputTokens: 65_536, outputTokens: 12 },
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'done' }],
        source: { provider: 'test-provider', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' })
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('25.0%/262k (auto)') })
    expect(plain(test.terminal.output)).toContain('test-model')
    // A local command repaints with the log unchanged, reading the cached occupancy.
    test.terminal.feed('/help')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('/quit') })
    await test.app.stop(0)
  })

  it('omits the occupancy until the meter knows a capacity', async () => {
    const test = await bench({ afterPrompt: () => {} }, { tokenMeter: true })
    expect(plain(test.terminal.output)).toContain('Enter send')
    expect(plain(test.terminal.output)).not.toContain('%')
    await test.app.stop(0)
  })

  it('omits the occupancy when the composition mounts no measurement service', async () => {
    const test = await bench({ afterPrompt: () => {} }, { projections: false })
    expect(plain(test.terminal.output)).toContain('Enter send')
    expect(plain(test.terminal.output)).not.toContain('%')
    await test.app.stop(0)
  })

  it('shows the key hints inside the empty composer, between its borders', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const rendered = plain(test.terminal.output)
    const hint = rendered.lastIndexOf('Enter send')
    expect(rendered.lastIndexOf('\u2500', hint)).toBeGreaterThan(-1)
    expect(rendered.indexOf('\u2500', hint)).toBeGreaterThan(hint)
    await test.app.stop(0)
  })

  it('rejects a non-interactive invocation before touching the terminal', async () => {
    internals.isInteractive = () => false
    const ctx = new Context()
    contexts.push(ctx)
    await expect(TuiApp.boot({
      ctx,
      config: { screen: 'inline' },
      cwd: process.cwd(),
      invocation: {},
      exit: () => {},
    })).rejects.toThrow(/interactive terminal/)
  })
})

describe('TuiApp plan mode', () => {
  /** Shift+Tab as a legacy terminal reports it. */
  const SHIFT_TAB = '\x1b[Z'

  /** The one Agent the fixture created. */
  function owned(test: Fixture): Agent {
    const agent = test.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('the fixture created no Agent')
    return agent
  }

  it('toggles plan mode with Shift+Tab and marks it in the footer', async () => {
    const test = await bench({ afterPrompt: () => {} }, { planMode: true })
    const agent = owned(test)
    expect(plain(test.terminal.output)).toContain('Shift+Tab plan')
    expect(plain(test.terminal.output)).not.toContain('○ idle  plan')

    test.terminal.feed(SHIFT_TAB)
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('plan mode on') })
    expect(test.ctx.planMode.get(agent).active).toBe(true)
    expect(plain(test.terminal.output)).toContain('○ idle  plan')

    test.terminal.feed(SHIFT_TAB)
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('plan mode off') })
    expect(test.ctx.planMode.get(agent).active).toBe(false)
    await test.app.stop(0)
  })

  it('reports a deployment that mounts no plan mode', async () => {
    const test = await bench({ afterPrompt: () => {} })
    expect(plain(test.terminal.output)).not.toContain('Shift+Tab plan')
    test.terminal.feed(SHIFT_TAB)
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('this deployment mounts no plan mode')
    })
    await test.app.stop(0)
  })

  it('ignores Shift+Tab while a prompt owns the keyboard', async () => {
    const test = await bench({ afterPrompt: () => {} }, { planMode: true, screen: 'alternate' })
    const agent = owned(test)
    const pending = test.app.choose('Select a model', [{ value: 'a', label: 'A' }])
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('Select a model') })

    test.terminal.feed(SHIFT_TAB)
    expect(test.ctx.planMode.get(agent).active).toBe(false)
    expect(plain(test.terminal.output)).not.toContain('plan mode on')

    test.terminal.feed('\x1b')
    await expect(pending).resolves.toBeUndefined()
    await test.app.stop(0)
  })

  it('queues entering plan mode while a turn is open', async () => {
    const test = await bench({ afterPrompt: () => {} }, { planMode: true })
    const agent = owned(test)
    agent.session.append('turn/start', { turn: 1 })

    test.terminal.feed(SHIFT_TAB)
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('entering plan mode from the next step')
    })
    expect(test.ctx.planMode.get(agent)).toEqual({ active: false, pending: true })
    await test.app.stop(0)
  })

  it('queues leaving plan mode while a turn is open', async () => {
    const test = await bench({ afterPrompt: () => {} }, { planMode: true })
    const agent = owned(test)
    test.terminal.feed(SHIFT_TAB)
    await vi.waitFor(() => { expect(test.ctx.planMode.get(agent).active).toBe(true) })

    agent.session.append('turn/start', { turn: 1 })
    test.terminal.feed(SHIFT_TAB)
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('leaving plan mode from the next step')
    })
    expect(test.ctx.planMode.get(agent)).toEqual({ active: true, pending: false })
    await test.app.stop(0)
  })

  it('toggles once when the terminal reports the key press and its release', async () => {
    const test = await bench({ afterPrompt: () => {} }, { planMode: true })
    const agent = owned(test)
    // One Shift+Tab as a kitty-protocol terminal reports it: press, then release.
    test.terminal.feed('\x1b[9;2u')
    test.terminal.feed('\x1b[9;2:3u')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('plan mode on') })
    expect(test.ctx.planMode.get(agent).active).toBe(true)
    expect(plain(test.terminal.output).match(/plan mode on/g)).toHaveLength(1)
    await test.app.stop(0)
  })
})

describe('TuiApp as a Cordis plugin', () => {
  it('declares every service it reads, so /model reaches the LLM registry', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
    await ctx.plugin(LlmRuntime)
    ctx.agents.setFactory({
      async createAgent(ownerCtx: Context, createOptions: CreateAgentOptions): Promise<AgentHandle> {
        const session = ctx.sessions.create(createOptions.sessionId)
        const agent: Agent = {
          id: session.id,
          options: createOptions.agentOptions ?? {},
          session,
          inbox: createInboxStub(),
          status: 'idle',
          ctx: ownerCtx,
          cancel: () => {},
          runMaintenance: () => Promise.reject(new Error('not used')),
          send: () => {},
          followup: () => {},
          steer: () => {},
          inject: () => {},
          whenIdle: () => Promise.resolve(),
        }
        await createOptions.setup?.(ownerCtx, agent)
        ctx.agents.register(agent)
        return { agent, dispose: () => Promise.resolve() }
      },
      resume: () => Promise.reject(new Error('not used')),
    })
    ctx.provide('appExit', () => {})
    ctx.provide(TUI_STARTUP_SERVICE, {})
    const terminal = new FakeTerminal()
    internals.isInteractive = () => true
    internals.createTerminal = () => terminal
    await ctx.plugin({ name, inject, apply }, { screen: 'inline' })
    await vi.waitFor(() => { expect(terminal.output).toContain('/help commands') })
    terminal.feed('/model')
    terminal.feed('\r')
    await vi.waitFor(() => { expect(terminal.output).toContain('no model route is registered') })
    expect(inject).toContain('llm')
    expect(terminal.output).not.toContain('without inject')
  })
})

describe('TuiApp prompt routing', () => {
  it('queues one modal at a time so parallel requests settle in order', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const first = test.app.ask('first?')
    const second = test.app.choose('second?', [{ value: 'ok', label: 'OK' }])
    await vi.waitFor(() => { expect(test.terminal.output).toContain('first?') })
    test.terminal.feed('typed')
    test.terminal.feed('\r')
    await expect(first).resolves.toBe('typed')
    await vi.waitFor(() => { expect(test.terminal.output).toContain('second?') })
    test.terminal.feed('\r')
    await expect(second).resolves.toMatchObject({ value: 'ok' })
    await test.app.stop(0)
  })
})

describe('TuiApp image paste', () => {
  /** One staged clipboard image, exactly as a platform reader would return it. */
  function clipboardImage(): ClipboardImage {
    return { data: Buffer.from(PNG_BASE64, 'base64'), mediaType: 'image/png' }
  }

  /** Substitute the image the app reads from the clipboard. */
  function pasteClipboard(image: ClipboardImage | undefined): void {
    internals.readClipboardImage = () => Promise.resolve(image)
  }

  it('submits a clipboard image with its prompt', async () => {
    const test = await bench({
      afterPrompt(session, message) { appendAnsweredTurn(session, message, 'a red square') },
    }, { attachments: true, modalities: ['text', 'image'] })
    pasteClipboard(clipboardImage())
    test.terminal.feed('\x16')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('[Image #1]') })
    test.terminal.feed('what is this?')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(test.submitted).toHaveLength(1) })
    const content = test.submitted[0]!.content
    expect(content[0]).toEqual({ type: 'text', text: 'what is this?' })
    expect(content[1]).toMatchObject({
      type: 'image',
      attachment: { mediaType: 'image/png', width: 2, height: 2 },
    })
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('› [Image #1] what is this?') })
    await test.app.stop(0)
  })

  it('submits an image-only prompt', async () => {
    const test = await bench({
      afterPrompt(session, message) { appendAnsweredTurn(session, message, 'a red square') },
    }, { attachments: true, modalities: ['text', 'image'] })
    pasteClipboard(clipboardImage())
    test.terminal.feed('\x16')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('[Image #1]') })
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(test.submitted).toHaveLength(1) })
    expect(test.submitted[0]!.content).toHaveLength(1)
    expect(test.submitted[0]!.content[0]).toMatchObject({ type: 'image', attachment: { mediaType: 'image/png' } })
    await test.app.stop(0)
  })

  it('pastes once when the terminal reports the key press and its release', async () => {
    const test = await bench({ afterPrompt: () => {} }, { attachments: true, modalities: ['text', 'image'] })
    const reads = vi.fn(() => Promise.resolve(clipboardImage()))
    internals.readClipboardImage = reads
    // One Ctrl+V as a kitty-protocol terminal reports it: press, then release.
    test.terminal.feed('\x1b[118;5u')
    test.terminal.feed('\x1b[118;5:3u')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('[Image #1]') })
    expect(reads).toHaveBeenCalledTimes(1)
    expect(plain(test.terminal.output)).not.toContain('[Image #2]')
    await test.app.stop(0)
  })

  it('reports a clipboard that holds no image', async () => {
    const test = await bench({ afterPrompt: () => {} })
    pasteClipboard(undefined)
    test.terminal.feed('\x16')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('no image on the clipboard') })
    await test.app.stop(0)
  })

  it('restores the draft when the routed model refuses images', async () => {
    const test = await bench({ afterPrompt: () => {} }, { attachments: true, modalities: ['text'] })
    pasteClipboard(clipboardImage())
    test.terminal.feed('\x16')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('[Image #1]') })
    test.terminal.feed('what is this?')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('does not accept image input') })
    expect(test.submitted).toHaveLength(0)
    // The composer still shows the refused draft after its refusal is reported.
    const rendered = plain(test.terminal.output)
    expect(rendered.lastIndexOf('what is this?')).toBeGreaterThan(rendered.lastIndexOf('does not accept image input'))
    await test.app.stop(0)
  })

  it('keeps text typed while a refused prompt was being admitted', async () => {
    const test = await bench({ afterPrompt: () => {} }, { attachments: true, modalities: ['text'] })
    pasteClipboard(clipboardImage())
    test.terminal.feed('\x16')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('[Image #1]') })
    test.terminal.feed('what is this?')
    test.terminal.feed('\r')
    // Typed while the refused admission was still in flight.
    test.terminal.feed('and this')
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('and this[Image #1] what is this?')
    })
    expect(test.submitted).toHaveLength(0)
    await test.app.stop(0)
  })

  it('restores the draft when the store refuses the pasted bytes', async () => {
    const test = await bench({ afterPrompt: () => {} }, { attachments: true, modalities: ['text', 'image'] })
    pasteClipboard({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' })
    test.terminal.feed('\x16')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('[Image #1]') })
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('Unsupported or malformed image data.') })
    expect(test.submitted).toHaveLength(0)
    await test.app.stop(0)
  })

  it('reports a deployment that stores no attachments', async () => {
    const test = await bench({ afterPrompt: () => {} }, { modalities: ['text', 'image'] })
    pasteClipboard(clipboardImage())
    test.terminal.feed('\x16')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('[Image #1]') })
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('this deployment stores no attachments') })
    expect(test.submitted).toHaveLength(0)
    await test.app.stop(0)
  })

  it('binds image paste to Alt+V where the terminal reserves Ctrl+V', async () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu'
    try {
      const test = await bench({ afterPrompt: () => {} }, { attachments: true, modalities: ['text', 'image'] })
      expect(plain(test.terminal.output)).toContain('Alt+V image')
      pasteClipboard(clipboardImage())
      test.terminal.feed('a')
      test.terminal.feed('\x1bv')
      await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('[Image #1]') })
      await test.app.stop(0)
    } finally {
      delete process.env.WSL_DISTRO_NAME
    }
  })
})

describe('reservesCtrlV', () => {
  it('reserves the key only for Windows consoles and WSL', () => {
    expect(reservesCtrlV('darwin', {})).toBe(false)
    expect(reservesCtrlV('win32', {})).toBe(true)
    expect(reservesCtrlV('linux', { WSL_DISTRO_NAME: 'Ubuntu' })).toBe(true)
  })
})
