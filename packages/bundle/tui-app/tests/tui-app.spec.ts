/**
 * The terminal application over the real registries and a scripted Agent
 * factory: composer routing, live rendering, modal answers, and exit.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import UserApprovalService from '@deepseek-ai/dsh-user-approval'
import { TuiApp, internals } from '../src/app.ts'
import { apply, inject, name, TUI_STARTUP_SERVICE } from '../src/index.ts'
import type { Config } from '../src/config.ts'
import { FakeTerminal } from './support/fake-terminal.ts'

const originalInternals = { ...internals }
const contexts: Context[] = []

afterEach(async () => {
  Object.assign(internals, originalInternals)
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** One scripted prompt reaction. */
interface Script {
  afterPrompt(session: Agent['session'], message: UserMessage): Promise<void> | void
}

/** The booted fixture: the app, its terminal, and the observed process facts. */
interface Fixture {
  ctx: Context
  terminal: FakeTerminal
  app: TuiApp
  exits: number[]
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
 * Boot the app over the real registries and a scripted Agent factory.
 * @param script - how the scripted Agent reacts to a prompt.
 * @param options - screen mode plus the optional measurement and compaction rows.
 * @returns the running fixture.
 */
async function bench(
  script: Script,
  options: { screen?: Config['screen']; tokenMeter?: boolean; compaction?: boolean; projections?: boolean } = {},
): Promise<Fixture> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  if (options.projections !== false) await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  await ctx.plugin(LlmRuntime)
  if (options.tokenMeter === true || options.compaction === true) await ctx.plugin(TokenMeter)
  if (options.compaction === true) await ctx.plugin(BasicCompactionEngine, { auto: true })
  await ctx.plugin(UserApprovalService, { policy: 'ask' })
  const exits: number[] = []
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
          agent.inbox.append('next-turn', message)
          idle = Promise.resolve().then(() => script.afterPrompt(session, message))
        },
        steer: () => {},
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
    test.terminal.feed('/definitely-not-a-command')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(test.terminal.output).toContain('unknown command') })
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
