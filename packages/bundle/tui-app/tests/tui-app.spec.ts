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
import type { Agent, AgentHandle, CreateAgentOptions, Model, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmModelReasoningInfo, LlmResolvedModelInfo, ModelModality, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import type { FileDiff, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { SelectItem } from '@earendil-works/pi-tui'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import SessionStore, { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SkillRegistry, { type SkillCandidate } from '@deepseek-ai/dsh-skill'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SUBAGENT_DESCRIPTOR_VERSION, SubagentRunId } from '@deepseek-ai/dsh-subagent'
import { subagentIdentityProjectionDefinition } from '@deepseek-ai/dsh-subagent/src/projection.ts'
import { subagentCatalogProjectionDefinition } from '@deepseek-ai/dsh-subagent/src/catalog.ts'
import * as SessionStatsPlugin from '@deepseek-ai/dsh-session-stats'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import UserApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import * as AskUserTool from '@deepseek-ai/dsh-tool-ask-user'
import { TuiApp, internals, reservesCtrlV, wheelScroll } from '../src/app.ts'
import type { PromptOutcome } from '../src/interactions.ts'
import { copyClipboardText } from '../src/clipboard.ts'
import { readWatchRecord } from '../src/watch/record.ts'
import type { ClipboardImage } from '../src/clipboard.ts'
import { apply, inject, name, TUI_STARTUP_SERVICE } from '../src/index.ts'
import { WatchApp } from '../src/watch/viewer.ts'
import type { Config } from '../src/config.ts'
import { textOfBlocks } from '../src/transcript.ts'
import type { TranscriptEntry } from '../src/transcript.ts'
import { FakeTerminal } from './support/fake-terminal.ts'
import { commandCatalog, executeCommand, listModelChoices, parseCommand, slashAutocomplete } from '../src/commands.ts'

/** A two-by-two PNG; the mounted attachment store decodes and admits real bytes. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwH4QZYAwAR8oH+Xm0fdIAAAAASUVORK5CYII='

const originalInternals = { ...internals }
const contexts: Context[] = []
const homes: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
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
  /** Publish a local subagent activation so the session counts it as running. */
  startSubagent(id: SessionId): void
  /** Settle a started subagent activation. */
  endSubagent(id: SessionId): void
  /** Descendant ids the surface asked the subagent service to interrupt. */
  interruptedSubagents: SessionId[]
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
  const renderer = Reflect.get(app, 'tui') as { previousScreen: string[] }
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
    sessionStats?: boolean
    compaction?: boolean
    projections?: boolean
    attachments?: boolean
    planMode?: boolean
    questions?: boolean
    tools?: boolean
    /** Mount a session-persistence service so exit names a resumable session. */
    persistence?: boolean
    /** Mount a persistence backend holding this one stored session, readable by `--resume` and `/resume`. */
    stored?: {
      sessionId: string
      history: readonly SessionEvent[]
      /** Runs inside the history read, to land a live event while the transcript is still loading. */
      whileReading?: (session: Session) => void
    }
    /** Resume this stored session at boot. */
    resume?: string
    /** Reject the scripted `resume` factory with this message, to exercise a failed session replacement. */
    resumeError?: string
    /** Stored sessions the picker lists, each with the title the query service folds for it. */
    storedList?: readonly {
      id: string
      createdAt: number
      cwd?: string
      /** Folded title; absent exercises the short-id fallback. */
      title?: string
      /** Fail this session's title read, to exercise the per-row fallback. */
      titleFailure?: boolean
    }[]
    /** Leave the session-query service unmounted, to exercise the id-only list. */
    withoutSessionQuery?: boolean
    models?: readonly LlmModelInfo[]
    modalities?: readonly ModelModality[]
    reasoning?: LlmModelReasoningInfo
    /** Mount a scripted subagent service so delegated work can be reported and stopped. */
    subagents?: boolean
    /** Mount the local bash executor over the local subprocess provider; `read-only` adds a confining policy. */
    shell?: boolean | 'read-only'
  } = {},
): Promise<Fixture> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  if (options.projections !== false) {
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.sessionProjections.register(subagentIdentityProjectionDefinition)
  }
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  await ctx.plugin(LlmRuntime)
  if (options.planMode === true || options.tools === true) {
    // `set()` folds the turn boundary to decide commit-versus-queue; the Agent
    // registry above owns that projection, while the scripted Agent owns the
    // lifecycle in place of the loop.
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    if (options.planMode === true) await ctx.plugin(PlanModeController, { section: 'Test plan mode instructions.' })
  }
  if (options.questions === true) await ctx.plugin(UserQuestionService)
  if (options.models !== undefined || options.modalities !== undefined || options.reasoning !== undefined) {
    ctx.llm.registerAdapter(['test-provider'], new ScriptedAdapter(options.models ?? [], options.modalities, options.reasoning))
  }
  if (options.attachments === true) {
    const home = await mkdtemp(join(tmpdir(), 'dsh-tui-attachments-'))
    homes.push(home)
    await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  }
  if (options.tokenMeter === true || options.compaction === true) await ctx.plugin(TokenMeter)
  if (options.sessionStats === true) await ctx.plugin(SessionStatsPlugin)
  if (options.compaction === true) await ctx.plugin(BasicCompactionEngine, { auto: true })
  await ctx.plugin(UserApprovalService, { policy: 'ask' })
  if (options.shell !== undefined) {
    await ctx.plugin(LocalSubprocessRuntime)
    if (options.shell === 'read-only') {
      await ctx.plugin(ReadOnlyBashExecutor)
      ctx.provide('sandboxPolicy', {
        resolve: () => ({ mode: 'read-only', workspaceRoot: process.cwd() }),
      } as never)
    } else {
      await ctx.plugin(LocalBashExecutor)
    }
  }
  const exits: number[] = []
  const submitted: UserMessage[] = []
  const steered: UserMessage[] = []
  const observed = { cancelled: 0, running: false }
  const publishAgent = async (
    ownerCtx: Context,
    session: Session,
    request: Pick<CreateAgentOptions, 'agentOptions' | 'setup'>,
  ): Promise<AgentHandle> => {
    const inbox = createInboxStub()
    let idle = Promise.resolve()
    const agent: Agent = {
      id: session.id,
      options: request.agentOptions ?? {},
      model: createAgentModel(request.agentOptions ?? {}),
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
    await request.setup?.(ownerCtx, agent)
    ctx.agents.register(agent)
    return { agent, dispose: () => Promise.resolve() }
  }
  ctx.agents.setFactory({
    async createAgent(ownerCtx: Context, createOptions: CreateAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.create(
        createOptions.sessionId,
        createOptions.meta === undefined ? undefined : { meta: createOptions.meta },
      )
      return await publishAgent(ownerCtx, session, createOptions)
    },
    async resume(ownerCtx: Context, resumeOptions: ResumeAgentOptions): Promise<AgentHandle> {
      if (options.resumeError !== undefined) throw new Error(options.resumeError)
      const session = ctx.sessions.create(resumeOptions.resumeSessionId, {
        seed: structuredClone([...(options.stored?.history ?? [])]),
      })
      return await publishAgent(ownerCtx, session, resumeOptions)
    },
  })
  ctx.provide('appExit', (code: number) => { exits.push(code) })
  const interruptedSubagents: SessionId[] = []
  const subagentRuns = new Map<SessionId, SubagentRunId>()
  const startSubagent = (id: SessionId): void => {
    const runId = SubagentRunId(`run-${String(id)}`)
    subagentRuns.set(id, runId)
    ctx.emit('subagent/start', { runId, provider: 'spawn', id, local: true })
  }
  const endSubagent = (id: SessionId): void => {
    const runId = subagentRuns.get(id) ?? SubagentRunId(`run-${String(id)}`)
    subagentRuns.delete(id)
    ctx.emit('subagent/end', { runId, provider: 'spawn', id, local: true, stopReason: 'aborted' })
  }
  // The real service owns catalog observation; this bench keeps the same
  // contract over the projections its fixtures append, including the failure a
  // composition without `sessionQuery` reports.
  const listDescendants = async (rootId: SessionId): Promise<Array<Record<string, unknown>>> => {
    if (ctx.get('sessionQuery') === undefined) {
      throw new Error('listing subagents requires the sessionQuery service (load @deepseek-ai/dsh-session-query)')
    }
    const rows: Array<Record<string, unknown>> = []
    const visited = new Set<SessionId>([rootId])
    const visit = (id: SessionId, depth: number): void => {
      const session = ctx.sessions.get(id)
      if (session === undefined) return
      const entries = ctx.sessionProjections.snapshot(session, ['subagentCatalog']).values.subagentCatalog ?? []
      for (const entry of entries) {
        if (visited.has(entry.id)) continue
        visited.add(entry.id)
        rows.push({ ...entry, kind: 'child', parentId: id, depth, activity: 'inactive', hasChildren: false })
        visit(entry.id, depth + 1)
      }
    }
    visit(rootId, 1)
    return rows
  }
  // The surface tracks running delegated work from the lifecycle pair and
  // stops each tracked child under the root Agent's ancestor authority.
  ctx.provide('subagents', {
    interrupt: (id: SessionId) => { interruptedSubagents.push(id) },
    listDescendants,
  } as never)
  if (options.withoutSessionQuery !== true && options.storedList === undefined) {
    // The listing stub only requires the service to exist; stored-session
    // fixtures mount their own richer query below.
    ctx.provide('sessionQuery', {} as never)
  }
  // Only the service's presence is under test for the exit hint; a `stored`
  // fixture additionally serves the read a resumed boot folds into the transcript.
  if (options.storedList !== undefined) {
    const entries = options.storedList
    const headerOf = (entry: (typeof entries)[number]): SessionHeader => ({
      version: SESSION_FORMAT_VERSION,
      id: SessionId(entry.id),
      createdAt: entry.createdAt,
      ...entry.cwd === undefined ? {} : { cwd: entry.cwd },
      isSeeded: false,
    })
    ctx.provide('sessionPersistence', {
      async list() {
        return entries.map(entry => ({ header: headerOf(entry), revision: 'test-revision' }))
      },
      async open(_id: string) {
        return {
          async read() {
            return { eventState: 'shared-frozen' as const, events: [] }
          },
          close: () => Promise.resolve(),
        }
      },
    } as never)
    if (options.withoutSessionQuery !== true) {
      ctx.provide('sessionQuery', {
        observeSession(id: SessionId) {
          const session = ctx.sessions.get(id)
          return {
            source: 'live' as const,
            header: session?.header,
            inheritedEventCount: 0,
            events: [],
            cursor: 0,
            projections: session === undefined
              ? { asOfSeq: 0, values: {} }
              : ctx.sessionProjections.snapshot(session, ['subagentCatalog']),
            dispose() {},
            [Symbol.dispose]() {},
          }
        },
        async readTitleSnapshots(ids: readonly SessionId[]) {
          return ids.map((id) => {
            const entry = entries.find(candidate => candidate.id === id)
            /* v8 ignore next -- the picker only requests ids this list returned */
            if (entry === undefined) throw new Error(`no stored session ${id}`)
            if (entry.titleFailure === true) {
              return { sessionId: id, status: 'rejected' as const, reason: new Error(`no title for ${id}`) }
            }
            return {
              sessionId: id,
              status: 'fulfilled' as const,
              value: {
                session: headerOf(entry),
                ...entry.title === undefined ? {} : {
                  title: {
                    title: entry.title,
                    messageSeqs: [],
                    source: { kind: 'fallback' as const },
                    eventSeq: 1,
                    updatedAt: entry.createdAt,
                  },
                },
              },
            }
          })
        },
      } as never)
    }
  } else if (options.stored !== undefined) {
    const stored = options.stored
    ctx.provide('sessionPersistence', {
      async open(id: string) {
        if (id !== stored.sessionId) throw new Error(`no stored session ${id}`)
        return {
          async read(offset = 0, length?: number) {
            const live = ctx.sessions.get(SessionId(stored.sessionId))
            if (live !== undefined) stored.whileReading?.(live)
            return {
              eventState: 'shared-frozen' as const,
              events: stored.history.slice(offset, length === undefined ? undefined : offset + length),
            }
          },
          close: () => Promise.resolve(),
        }
      },
    } as never)
  } else if (options.persistence === true) {
    ctx.provide('sessionPersistence', {} as SessionPersistence)
  }
  const terminal = new FakeTerminal()
  internals.isInteractive = () => true
  internals.createTerminal = () => terminal
  internals.copyClipboardText = (text, write) => copyClipboardText(text, write, { platform: 'linux', env: {} })
  const app = await TuiApp.boot({
    ctx,
    config: { screen: options.screen ?? 'inline', colorScheme: 'auto' },
    cwd: process.cwd(),
    invocation: options.resume === undefined ? {} : { resume: options.resume },
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
    startSubagent,
    endSubagent,
    interruptedSubagents,
  }
}

/** The one Agent the fixture created. */
function owned(test: Fixture): Agent {
  const agent = test.ctx.agents.list()[0]
  if (agent === undefined) throw new Error('the fixture created no Agent')
  return agent
}

/**
 * The assistant text rows the app's transcript currently holds.
 * @param test - the running fixture.
 * @returns each assistant row's text, in order.
 */
function assistantRows(test: Fixture): string[] {
  const transcript = Reflect.get(test.app, 'transcript') as { entries(): readonly TranscriptEntry[] }
  return transcript.entries().flatMap(entry => entry.kind === 'assistant' ? [entry.text] : [])
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

/**
 * Append `turns` numbered answered turns, giving the transcript a scrollback.
 *
 * Each prompt and reply carries its index, so a test can tell which rows a
 * scroll position shows.
 * @param session - the session to append to.
 * @param turns - how many turns to append.
 */
function appendScrollback(session: Agent['session'], turns: number): void {
  for (let index = 1; index <= turns; index += 1) {
    const suffix = String(index).padStart(2, '0')
    appendAnsweredTurn(session, createUserMessage({
      content: [{ type: 'text', text: `PROMPT-${suffix}` }],
      source: { kind: 'user' },
    }), `REPLY-${suffix}`)
  }
}

/**
 * The durable events of one stored answered turn, as a resumed Session seeds them.
 * @param prompt - the stored prompt text.
 * @param reply - the stored reply text.
 * @returns the events in sequence order.
 */
function storedTurn(prompt: string, reply: string): SessionEvent[] {
  const session = Session.create(SessionId('stored-history'))
  appendAnsweredTurn(session, createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  }), reply)
  return [...session.ownEvents()]
}

/** A structural Agent Model over the route the fake Agent was created with. */
function createAgentModel(options: { provider?: string | undefined; model?: string | undefined }): Model {
  let current = options.provider === undefined || options.model === undefined
    ? undefined
    : { provider: options.provider, model: options.model }
  return {
    current: () => current === undefined ? undefined : { ...current },
    select: (selection) => { current = { ...selection } },
  }
}

/** Execute one model-shaped call through the batch executor and return its result. */
async function executeTool(
  ctx: Context,
  agent: Agent,
  call: { readonly id: ToolCallId; readonly name: string; readonly arguments: Record<string, unknown> },
  signal: AbortSignal = new AbortController().signal,
): Promise<ToolExecutionResult> {
  const modelSelection = agent.model.current()
  if (modelSelection === undefined) throw new Error('the test Agent has no model selection')
  const toolSet = await ctx.tools.resolve({ agent, modelSelection, signal })
  try {
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }],
      signal,
      agent,
      toolSet,
    })
    const result = batch.results[0]?.result
    if (result === undefined) throw new Error('tool batch returned no result')
    return result
  } finally {
    toolSet.dispose()
  }
}

describe('TuiApp', () => {
  it.each(['inline', 'alternate'] as const)('suggests and completes a skill in the %s composer', async (screenMode) => {
    const test = await bench({ afterPrompt: () => {} }, { screen: screenMode })
    await test.ctx.plugin(SkillRegistry)
    test.ctx.skills.register({ name: 'ponytail', description: 'Keep code minimal', source: 'runtime', content: 'Use minimal code.' })
    test.terminal.feed('/pon')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('Keep code minimal') })
    test.terminal.feed('\t')
    expect(test.submitted).toHaveLength(0)
    test.terminal.feed('full')
    test.terminal.feed('\r')
    expect(test.submitted[0]?.content).toEqual([{ type: 'text', text: '/ponytail full' }])
    await test.app.stop(0)
  })

  it('dismisses slash suggestions without interrupting a running Agent', async () => {
    const test = await bench({ afterPrompt: () => {} })
    test.setRunning(true)
    test.terminal.feed('/')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('List available commands') })
    test.terminal.feed('\x1b')
    expect(test.cancelled()).toBe(0)
    test.terminal.feed('\x1b')
    expect(test.cancelled()).toBe(1)
    await test.app.stop(0)
  })

  it('refreshes slash candidates and gives commands precedence over user-invocable skills', async () => {
    const test = await bench({ afterPrompt: () => {} })
    await test.ctx.plugin(SkillRegistry)
    for (const [name, userInvocable] of [['help', true], ['hidden', false], ['manual', true]] as const) {
      test.ctx.skills.register({
        name, description: `Skill ${name}`, content: name, source: 'runtime',
        invocation: { userInvocable, modelInvocable: false },
      })
    }
    const provider = slashAutocomplete(test.ctx, owned(test), process.cwd())
    const options = { signal: new AbortController().signal }
    const suggestions = await provider.getSuggestions(['/'], 0, 1, options)
    expect(suggestions?.items.filter(item => item.value === 'help')).toEqual([
      { value: 'help', label: 'help', description: 'List available commands' },
    ])
    expect(suggestions?.items.some(item => item.value === 'hidden')).toBe(false)
    expect(suggestions?.items.some(item => item.value === 'manual')).toBe(true)
    const dispose = test.ctx.skills.register({ name: 'fresh', description: 'New skill', content: '', source: 'runtime' })
    expect((await provider.getSuggestions(['/fr'], 0, 3, options))?.items[0]?.value).toBe('fresh')
    dispose()
    expect(await provider.getSuggestions(['/fr'], 0, 3, options)).toBeNull()
    expect(await provider.getSuggestions(['/tmp/file'], 0, 9, options)).toBeNull()
    expect(await provider.getSuggestions(['/manual text'], 0, 12, options)).toBeNull()
    await test.app.stop(0)
  })

  it('abandons a slash completion request cancelled during skill discovery', async () => {
    const test = await bench({ afterPrompt: () => {} })
    await test.ctx.plugin(SkillRegistry)
    test.ctx.skills.registerProvider(() => ({
      name: 'slow',
      list: () => new Promise<readonly SkillCandidate[]>(() => {}),
      get: () => Promise.resolve(undefined),
    }))
    const provider = slashAutocomplete(test.ctx, owned(test), process.cwd())
    const controller = new AbortController()
    const pending = provider.getSuggestions(['/gr'], 0, 3, { signal: controller.signal })
    controller.abort()
    await expect(pending).resolves.toBeNull()
    await test.app.stop(0)
  })

  it('surfaces a skill catalog failure that is not a cancellation', async () => {
    const test = await bench({ afterPrompt: () => {} })
    await test.ctx.plugin(SkillRegistry)
    const candidate: SkillCandidate = {
      name: 'broken-skill',
      description: '',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'runtime',
      provider: 'broken',
      rank: 0,
      locator: undefined,
    }
    test.ctx.skills.registerProvider(() => ({
      name: 'broken',
      list: () => Promise.resolve([candidate]),
      get: () => Promise.resolve(undefined),
    }))
    const provider = slashAutocomplete(test.ctx, owned(test), process.cwd())
    await expect(provider.getSuggestions(['/br'], 0, 3, { signal: new AbortController().signal }))
      .rejects.toThrow('without a description')
    await test.app.stop(0)
  })

  it('keeps the typed slash token when the suggestion list lags behind it', async () => {
    const test = await bench({ afterPrompt: () => {} })
    await test.ctx.plugin(SkillRegistry)
    const provider = slashAutocomplete(test.ctx, owned(test), process.cwd())
    const stale = provider.applyCompletion(
      ['/grill-me'], 0, 9, { value: 'help', label: 'help' }, '/',
    )
    expect(stale.lines).toEqual(['/grill-me'])
    expect(stale.cursorCol).toBe(9)
    const current = provider.applyCompletion(
      ['/gri'], 0, 4, { value: 'grill-me', label: 'grill-me' }, '/gri',
    )
    expect(current.lines).toEqual(['/grill-me '])
    expect(current.cursorCol).toBe(10)
    const untouched = provider.applyCompletion(
      ['/tmp/file'], 0, 9, { value: 'file', label: 'file' }, '/tmp',
    )
    expect(untouched.lines).toEqual(['/tmp/file'])
    expect(await provider.getSuggestions([], 0, 0, { signal: new AbortController().signal })).toBeNull()
    expect(provider.applyCompletion([], 0, 0, { value: 'grill-me', label: 'grill-me' }, '').lines).toEqual([])
    await test.app.stop(0)
  })

  it('parses a slash line with and without trailing input', () => {
    expect(parseCommand('/help')).toEqual({ name: 'help', input: '' })
    expect(parseCommand('/resume abc def')).toEqual({ name: 'resume', input: 'abc def' })
    expect(parseCommand('/Help')).toBeUndefined()
  })

  it('reports no execution when the deployment mounts no command registry', async () => {
    const test = await bench({ afterPrompt: () => {} })
    expect(await executeCommand(test.ctx, owned(test), '/help', new AbortController().signal)).toBeUndefined()
    await test.app.stop(0)
  })

  it('advertises a registered command input hint in the catalog', async () => {
    const test = await bench({ afterPrompt: () => {} })
    await test.ctx.plugin(CommandRuntime)
    test.ctx.commands.register({
      name: 'deploy',
      description: 'Deploy the workspace',
      input: { hint: 'target environment' },
      handler: () => ({ kind: 'success' as const }),
    })
    expect(commandCatalog(test.ctx, owned(test)).find(item => item.value === '/deploy')?.description)
      .toBe('Deploy the workspace target environment')
    await test.app.stop(0)
  })

  it('submits the typed skill gesture while the menu still shows an older list', async () => {
    const test = await bench({ afterPrompt: () => {} })
    await test.ctx.plugin(SkillRegistry)
    test.ctx.skills.register({ name: 'grill-me', description: 'Interview the user relentlessly', source: 'runtime', content: 'Ask one question at a time.' })
    test.terminal.feed('/')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('List available commands') })
    test.terminal.feed('grill-me')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(test.submitted).toHaveLength(1) })
    expect(test.submitted[0]?.content).toEqual([{ type: 'text', text: '/grill-me' }])
    await test.app.stop(0)
  })

  it('omits a provider whose model discovery fails', async () => {
    const test = await bench({ afterPrompt: () => {} }, {
      models: [{ provider: 'test-provider', id: 'test-model', name: 'Test Model' }],
    })
    vi.spyOn(test.ctx.llm, 'listModels').mockRejectedValueOnce(new Error('catalog unavailable'))
    expect(await listModelChoices(test.ctx)).toEqual([])
    await test.app.stop(0)
  })

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

  it('shows delegated subagents in a pinned live panel without touching the running turn', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate' })
    test.setRunning(true)
    await test.ctx.sessionProjections.register(subagentCatalogProjectionDefinition)
    const root = owned(test).session
    const child = SessionId('session-subagent-child')
    const leaf = SessionId('session-subagent-leaf')
    const external = SessionId('session-subagent-external')
    root.append('subagent/catalog', {
      version: 0, childId: child, childCreatedAt: 1, mode: 'continuable', label: 'explore',
    })
    const resident = test.ctx.sessions.create(child)
    resident.append('subagent/catalog', {
      version: 1, childId: leaf, childCreatedAt: 2, mode: 'one-shot',
    })
    // A repeated catalog row is one child: the walk visits it once.
    resident.append('subagent/catalog', {
      version: 1, childId: leaf, childCreatedAt: 2, mode: 'one-shot',
    })
    root.append('subagent/catalog', {
      version: 2, childId: external, childCreatedAt: 3, mode: 'external', label: 'remote review',
    })
    test.startSubagent(child)
    test.terminal.feed('/subagents')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(screen(test.app).some(row => row.includes('● explore'))).toBe(true) })
    const panel = screen(test.app).join('\n')
    expect(panel).toContain('subagents · 3 total · 1 running')
    expect(screen(test.app).some(row => row.trim() === 'Subagents')).toBe(false)
    const rows = screen(test.app)
    const summary = rows.findIndex(row => row.includes('subagents · 3 total · 1 running'))
    expect(rows[summary + 1]).toContain('● explore')
    expect(panel).toContain('↳ ○')
    expect(panel).toContain('· one-shot · dsh watch session-subagent-leaf')
    expect(panel).toContain('◇ remote review · external · no local session')
    // Pinned: a transcript frame lands behind the panel and the panel stays put.
    appendAnsweredTurn(root, createUserMessage({
      content: [{ type: 'text', text: 'behind the panel' }],
      source: { kind: 'user' },
    }), 'streamed while open')
    await vi.waitFor(() => { expect(screen(test.app).join('\n')).toContain('streamed while open') })
    expect(screen(test.app).some(row => row.includes('● explore'))).toBe(true)
    // Live: a child started while the panel is open joins the list.
    const late = SessionId('session-subagent-late')
    root.append('subagent/catalog', {
      version: 0, childId: late, childCreatedAt: 4, mode: 'one-shot', label: 'late task',
    })
    test.startSubagent(late)
    await vi.waitFor(() => { expect(screen(test.app).join('\n')).toContain('late task') })
    // The panel never writes a transcript row.
    const transcript = Reflect.get(test.app, 'transcript') as { entries(): readonly TranscriptEntry[] }
    expect(transcript.entries().some(entry => entry.kind === 'notice' && entry.text.includes('subagents'))).toBe(false)
    // The command is local: it neither cancels the turn nor steers it as text.
    expect(test.cancelled()).toBe(0)
    expect(test.steered).toHaveLength(0)
    expect(test.submitted).toHaveLength(0)
    test.terminal.feed('\x1b')
    await vi.waitFor(() => { expect(screen(test.app).some(row => row.includes('● explore'))).toBe(false) })
    // Ctrl+C closes the panel rather than cancelling the turn behind it.
    test.terminal.feed('/subagents')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(screen(test.app).some(row => row.includes('● explore'))).toBe(true) })
    test.terminal.feed('\x03')
    await vi.waitFor(() => { expect(screen(test.app).some(row => row.includes('● explore'))).toBe(false) })
    expect(test.cancelled()).toBe(0)
    expect(test.steered).toHaveLength(0)
    expect(test.submitted).toHaveLength(0)
    await test.app.stop(0)
  })

  it('scrolls a long subagent panel without writing a transcript row', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate' })
    await test.ctx.sessionProjections.register(subagentCatalogProjectionDefinition)
    const root = owned(test).session
    for (let index = 0; index < 20; index += 1) {
      root.append('subagent/catalog', {
        version: 0,
        childId: SessionId(`session-scroll-${String(index)}`),
        childCreatedAt: index,
        mode: 'one-shot',
        label: `task-${String(index)}`,
      })
    }
    test.terminal.feed('/subagents')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('showing 1-16 of 20'))).toBe(true)
    })
    test.terminal.feed('\x1b[B')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('showing 2-17 of 20'))).toBe(true)
    })
    test.terminal.feed('\x1b[6~')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('showing 5-20 of 20'))).toBe(true)
    })
    const transcript = Reflect.get(test.app, 'transcript') as { entries(): readonly TranscriptEntry[] }
    expect(transcript.entries().some(entry => entry.kind === 'notice')).toBe(false)
    test.terminal.feed('\x1b')
    await vi.waitFor(() => { expect(screen(test.app).some(row => row.includes('showing 5-20 of 20'))).toBe(false) })
    await test.app.stop(0)
  })

  it('opens the subagent panel on the inline screen', async () => {
    const test = await bench({ afterPrompt: () => {} })
    await test.ctx.sessionProjections.register(subagentCatalogProjectionDefinition)
    const root = owned(test).session
    root.append('subagent/catalog', {
      version: 0, childId: SessionId('session-inline-child'), childCreatedAt: 1, mode: 'one-shot', label: 'inline task',
    })
    test.terminal.feed('/subagents')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('inline task') })
    const transcript = Reflect.get(test.app, 'transcript') as { entries(): readonly TranscriptEntry[] }
    expect(transcript.entries().some(entry => entry.kind === 'notice' && entry.text.includes('subagents'))).toBe(false)
    test.terminal.feed('\x1b')
    await test.app.stop(0)
  })

  it('shows an empty subagent panel without a transcript row', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate' })
    test.terminal.feed('/subagents')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(screen(test.app).some(row => row.includes('no subagents in this session'))).toBe(true) })
    const transcript = Reflect.get(test.app, 'transcript') as { entries(): readonly TranscriptEntry[] }
    expect(transcript.entries().some(entry => entry.kind === 'notice' && entry.text.includes('subagents'))).toBe(false)
    test.terminal.feed('\x1b')
    await vi.waitFor(() => { expect(screen(test.app).some(row => row.includes('no subagents in this session'))).toBe(false) })
    await test.app.stop(0)
  })

  it('shows a missing session query in the subagent panel', async () => {
    const test = await bench({ afterPrompt: () => {} }, { withoutSessionQuery: true })
    test.terminal.feed('/subagents')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('listing subagents requires the sessionQuery service')
    })
    const transcript = Reflect.get(test.app, 'transcript') as { entries(): readonly TranscriptEntry[] }
    expect(transcript.entries().some(entry => entry.kind === 'notice')).toBe(false)
    test.terminal.feed('\x1b')
    await test.app.stop(0)
  })

  it('shows a non-Error listing failure in the subagent panel', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const subagents = test.ctx.subagents
    const list = subagents.listDescendants.bind(subagents)
    subagents.listDescendants = () => { throw 'catalog unavailable' }
    test.terminal.feed('/subagents')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('catalog unavailable') })
    const transcript = Reflect.get(test.app, 'transcript') as { entries(): readonly TranscriptEntry[] }
    expect(transcript.entries().some(entry => entry.kind === 'notice')).toBe(false)
    // The footer reads the same cache to keep its delegated-work marker current,
    // so restore the service before closing the panel; the panel is the one
    // surface that reports the failure.
    subagents.listDescendants = list
    test.terminal.feed('\x1b')
    await test.app.stop(0)
  })

  it('reports delegated subagents beside the footer occupancy as they start and settle', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate' })
    await test.ctx.sessionProjections.register(subagentCatalogProjectionDefinition)
    expect(screen(test.app).some(row => row.includes('subagents ('))).toBe(false)
    const root = owned(test).session
    const child = SessionId('session-footer-child')
    const leaf = SessionId('session-footer-leaf')
    root.append('subagent/catalog', {
      version: 0, childId: child, childCreatedAt: 1, mode: 'continuable', label: 'footer task',
    })
    const resident = test.ctx.sessions.create(child)
    resident.append('subagent/catalog', { version: 1, childId: leaf, childCreatedAt: 2, mode: 'one-shot' })
    test.startSubagent(child)
    test.startSubagent(leaf)
    await vi.waitFor(() => { expect(screen(test.app).some(row => row.includes('● subagents (2/2)'))).toBe(true) })
    test.endSubagent(leaf)
    await vi.waitFor(() => { expect(screen(test.app).some(row => row.includes('● subagents (1/2)'))).toBe(true) })
    test.endSubagent(child)
    await vi.waitFor(() => { expect(screen(test.app).some(row => row.includes('○ subagents (0/2)'))).toBe(true) })
    await test.app.stop(0)
  })

  it('lists commands for /help without submitting a model prompt', async () => {
    const test = await bench({ afterPrompt: () => {} })
    test.terminal.feed('/help')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(test.terminal.output).toContain('/quit') })
    expect(plain(test.terminal.output)).toContain('/subagents')
    expect(plain(test.terminal.output)).toContain('/effort')
    expect(test.submitted).toHaveLength(0)
    await test.app.stop(0)
  })

  it.each([false, true])('passes unclaimed slash text to the Agent (running: %s)', async (running) => {
    const test = await bench({ afterPrompt: () => {} })
    test.setRunning(running)
    for (const text of ['/ponytail full', '/definitely-not-a-command']) {
      test.terminal.feed(text)
      test.terminal.feed('\r')
    }
    expect((running ? test.steered : test.submitted).map(message => message.content)).toEqual([
      [{ type: 'text', text: '/ponytail full' }],
      [{ type: 'text', text: '/definitely-not-a-command' }],
    ])
    await test.app.stop(0)
  })

  it('dispatches a registered command before treating its name as a skill gesture', async () => {
    const test = await bench({ afterPrompt: () => {} })
    await test.ctx.plugin(CommandRuntime)
    const handler = vi.fn(() => ({ kind: 'success' as const, text: 'command handled' }))
    test.ctx.commands.register({ name: 'ponytail', description: 'A deployment command', handler })
    expect(commandCatalog(test.ctx, owned(test)).find(item => item.value === '/ponytail')?.description)
      .toBe('A deployment command')
    test.terminal.feed('/ponytail full')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('command handled') })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(test.submitted).toHaveLength(0)
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

  it('keeps Ctrl+D quitting after /new replaces the session', async () => {
    const test = await bench({ afterPrompt: () => {} })
    test.terminal.feed('/new')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('started a new session') })

    test.terminal.feed('\x04')
    await vi.waitFor(() => { expect(test.exits).toEqual([0]) })
  })

  it('interrupts a running turn on Escape without ending the session', async () => {
    const test = await bench({ afterPrompt: () => {} })
    test.setRunning(true)
    test.terminal.feed('\x1b')
    await vi.waitFor(() => { expect(test.cancelled()).toBe(1) })
    await vi.waitFor(() => { expect(test.terminal.output).toContain('cancelling') })
    expect(test.exits).toEqual([])
    await test.app.stop(0)
    expect(test.exits).toEqual([0])
  })

  it('ignores Escape while the Agent is idle', async () => {
    const test = await bench({ afterPrompt: () => {} })
    test.terminal.feed('\x1b')
    expect(test.cancelled()).toBe(0)
    expect(test.exits).toEqual([])
    await test.app.stop(0)
  })

  it('lets a focused prompt own Escape as a skip and Ctrl+C as a cancel instead of interrupting the running turn', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate' })
    test.setRunning(true)
    const pending = test.app.choose('Select a model', [{ value: 'a', label: 'A' }])
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('Select a model') })

    test.terminal.feed('\x1b')
    await expect(pending).resolves.toEqual({ kind: 'skip' })
    expect(test.cancelled()).toBe(0)

    const cancelling = test.app.choose('Select a model', [{ value: 'a', label: 'A' }])
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('Select a model') })
    test.terminal.feed('\x03')
    await expect(cancelling).resolves.toEqual({ kind: 'cancel' })
    expect(test.cancelled()).toBe(0)
    await test.app.stop(0)
  })

  it('closes transcript search on Escape instead of interrupting the running turn', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate' })
    test.setRunning(true)
    // Ctrl+Shift+F as a kitty-protocol terminal reports it.
    test.terminal.feed('\x1b[102;6u')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('Find in transcript') })

    test.terminal.feed('\x1b')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('Find in transcript'))).toBe(false)
    })
    expect(test.cancelled()).toBe(0)

    // With the search closed, Escape reaches the app and interrupts the turn.
    test.terminal.feed('\x1b')
    await vi.waitFor(() => { expect(test.cancelled()).toBe(1) })
    await test.app.stop(0)
  })

  it('interrupts a running subagent on Escape while the Agent itself is idle', async () => {
    const test = await bench({ afterPrompt: () => {} }, { subagents: true })
    test.startSubagent(SessionId('child-1'))

    test.terminal.feed('\x1b')

    await vi.waitFor(() => { expect(test.interruptedSubagents).toEqual([SessionId('child-1')]) })
    expect(test.cancelled()).toBe(1)
    expect(test.exits).toEqual([])
    await test.app.stop(0)
  })

  it('interrupts subagents on Ctrl+C instead of exiting while the Agent is idle', async () => {
    const test = await bench({ afterPrompt: () => {} }, { subagents: true })
    test.startSubagent(SessionId('child-1'))

    test.terminal.feed('\x03')

    await vi.waitFor(() => { expect(test.interruptedSubagents).toEqual([SessionId('child-1')]) })
    expect(test.exits).toEqual([])
    await test.app.stop(0)
  })

  it('publishes the watch command only after a local subagent record lands', async () => {
    const test = await bench({ afterPrompt: () => {} }, { subagents: true, screen: 'alternate' })
    const home = await mkdtemp(join(tmpdir(), 'dsh-tui-watch-'))
    homes.push(home)
    vi.stubEnv('DSH_HOME', home)
    const parent = owned(test)
    const child = await test.ctx.agents.create({
      sessionId: SessionId('watch-child'),
      parentAgent: parent,
      meta: { parentSession: parent.session.id, origin: 'subagent', cwd: process.cwd() },
    })
    test.startSubagent(child.agent.id)

    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('dsh watch watch-child'))).toBe(true)
    })
    const rows = screen(test.app)
    expect(rows.filter(row => row.includes('watch-child'))).toEqual(['· watch: dsh watch watch-child'])
    const record = await readWatchRecord('watch-child')
    expect(record?.sessionId).toBe('watch-child')
    await test.app.stop(0)
    expect(await readWatchRecord('watch-child')).toBeUndefined()
  })

  it('reports a running session and offers cancel while only a subagent works', async () => {
    const test = await bench({ afterPrompt: () => {} }, { subagents: true })
    test.startSubagent(SessionId('child-1'))

    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('Esc/Ctrl+C cancel') })
    expect(plain(test.terminal.output)).toContain('running')
    await test.app.stop(0)
  })

  it('returns the footer to idle when the last subagent settles', async () => {
    const test = await bench({ afterPrompt: () => {} }, { subagents: true, screen: 'alternate' })
    test.startSubagent(SessionId('child-1'))
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('Esc/Ctrl+C cancel'))).toBe(true)
    })

    test.endSubagent(SessionId('child-1'))

    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('Esc/Ctrl+C cancel'))).toBe(false)
    })
    await test.app.stop(0)
  })

  it('reports a manual compaction in the footer until its end marker', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate' })
    await test.ctx.plugin(CommandRuntime)
    const compactionId = CompactionId('manual-compaction')
    const session = owned(test).session
    let settle: () => void = () => {}
    test.ctx.commands.register({
      name: 'compact',
      description: 'Compact older conversation history',
      handler: () => new Promise((resolve) => {
        session.append('compaction/start', { compactionId, turn: null })
        settle = () => {
          session.append('compaction/end', { compactionId, turn: null })
          resolve({ kind: 'success' as const, text: 'Compacted 2 history items.' })
        }
      }),
    })
    test.terminal.feed('/compact')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('● compacting'))).toBe(true)
    })
    settle()
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('○ idle'))).toBe(true)
    })
    await test.app.stop(0)
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

  it('rejects an approval request from the modal list', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const agent = owned(test)
    agent.session.append('turn/start', { turn: 1 })
    const decision = test.ctx.approval.request({ agent, toolName: 'bash' })
    await vi.waitFor(() => { expect(test.terminal.output).toContain('Allow bash?') })
    test.terminal.feed('\x1b[B')
    test.terminal.feed('\x1b[B')
    test.terminal.feed('\r')
    await expect(decision).resolves.toBe('rejected')
    await test.app.stop(0)
  })

  it('remembers Always allow for the session and its subagents', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const agent = owned(test)
    agent.session.append('turn/start', { turn: 1 })
    const choose = vi.spyOn(test.app, 'choose')
    const first = test.ctx.approval.request({ agent, toolName: 'bash', reason: 'needs the workspace' })
    await vi.waitFor(() => { expect(test.terminal.output).toContain('Always allow bash') })
    test.terminal.feed('\x1b[B')
    test.terminal.feed('\r')
    await expect(first).resolves.toBe('allowed-once')
    await vi.waitFor(() => { expect(test.terminal.output).toContain('allowed always') })
    expect(agent.session.snapshotEvents().filter(event => event.type === 'approval/grant')).toMatchObject([
      { data: { toolName: 'bash' } },
    ])
    choose.mockClear()

    const second = test.ctx.approval.request({ agent, toolName: 'bash' })
    await expect(second).resolves.toBe('allowed-once')
    expect(choose).not.toHaveBeenCalled()

    const child = await test.ctx.agents.create({
      sessionId: SessionId('grant-child'),
      parentAgent: agent,
      meta: { parentSession: agent.session.id, origin: 'subagent', cwd: process.cwd() },
    })
    child.agent.session.append('turn/start', { turn: 1 })
    const third = test.ctx.approval.request({ agent: child.agent, toolName: 'bash' })
    await expect(third).resolves.toBe('allowed-once')
    expect(choose).not.toHaveBeenCalled()
    await test.app.stop(0)
  })

  it('remembers Always allow chosen on a descendant for the root session', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const root = owned(test)
    const child = await test.ctx.agents.create({
      sessionId: SessionId('grant-child-root'),
      parentAgent: root,
      meta: { parentSession: root.session.id, origin: 'subagent', cwd: process.cwd() },
    })
    child.agent.session.append('turn/start', { turn: 1 })
    const choose = vi.spyOn(test.app, 'choose')
    const childDecision = test.ctx.approval.request({ agent: child.agent, toolName: 'bash' })
    await vi.waitFor(() => { expect(test.terminal.output).toContain('Always allow bash') })
    test.terminal.feed('\x1b[B')
    test.terminal.feed('\r')
    await expect(childDecision).resolves.toBe('allowed-once')
    expect(root.session.snapshotEvents().filter(event => event.type === 'approval/grant')).toMatchObject([
      { data: { toolName: 'bash' } },
    ])
    choose.mockClear()

    root.session.append('turn/start', { turn: 1 })
    const rootDecision = test.ctx.approval.request({ agent: root, toolName: 'bash' })
    await expect(rootDecision).resolves.toBe('allowed-once')
    expect(choose).not.toHaveBeenCalled()
    await test.app.stop(0)
  })

  it('does not grant Always allow when the request is cancelled as the prompt settles', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const agent = owned(test)
    agent.session.append('turn/start', { turn: 1 })
    let respond: ((outcome: PromptOutcome<SelectItem>) => void) | undefined
    vi.spyOn(test.app, 'choose').mockImplementation(() => new Promise<PromptOutcome<SelectItem>>((resolve) => {
      respond = resolve
    }))
    const withdraw = new AbortController()
    const decision = test.ctx.approval.request({ agent, toolName: 'bash', signal: withdraw.signal })
    await vi.waitFor(() => { expect(respond).toBeDefined() })

    // Resolve the prompt and withdraw the request before the answerer's
    // continuation runs: the service settles `cancelled`, so the choice must
    // not still be written as a remembered grant.
    respond!({ kind: 'answer', value: { value: 'allow-always', label: 'Always allow bash' } })
    withdraw.abort()

    await expect(decision).resolves.toBe('cancelled')
    expect(test.ctx.approval.isGranted(agent, 'bash')).toBe(false)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'approval/grant')).toEqual([])
    await test.app.stop(0)
  })

  it('cancels a descendant approval on Escape', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const parent = owned(test)
    const child = await test.ctx.agents.create({
      sessionId: SessionId('cancel-child'),
      parentAgent: parent,
      meta: { parentSession: parent.session.id, origin: 'subagent', cwd: process.cwd() },
    })
    child.agent.session.append('turn/start', { turn: 1 })
    const decision = test.ctx.approval.request({ agent: child.agent, toolName: 'bash' })
    await vi.waitFor(() => { expect(test.terminal.output).toContain('Allow bash?') })
    test.terminal.feed('\x1b')
    await expect(decision).resolves.toBe('cancelled')
    await test.app.stop(0)
  })

  it('answers a nested descendant approval under its subagent label', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const parent = owned(test)
    const child = await test.ctx.agents.create({
      sessionId: SessionId('approval-child'),
      parentAgent: parent,
      meta: { parentSession: parent.session.id, origin: 'subagent', cwd: process.cwd() },
    })
    const grandchild = await test.ctx.agents.create({
      sessionId: SessionId('approval-grandchild'),
      parentAgent: child.agent,
      meta: {
        parentSession: child.agent.session.id,
        origin: 'subagent',
        delegationDepth: 2,
        cwd: process.cwd(),
      },
    })
    grandchild.agent.session.append('subagent/descriptor', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'one-shot',
      provider: 'spawn',
      label: 'explorer',
    })
    grandchild.agent.session.append('turn/start', { turn: 1 })
    const decision = test.ctx.approval.request({
      agent: grandchild.agent,
      toolName: 'bash',
      reason: 'needs the workspace',
    })
    await vi.waitFor(() => {
      expect(test.terminal.output).toContain('subagent · explorer')
      expect(test.terminal.output).toContain('Allow bash?')
    })
    test.terminal.feed('\r')
    await expect(decision).resolves.toBe('allowed-once')
    await test.app.stop(0)
  })

  it('falls back to the short id for a descendant without a descriptor', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const parent = owned(test)
    const child = await test.ctx.agents.create({
      sessionId: SessionId('child-y'),
      parentAgent: parent,
      meta: { parentSession: parent.session.id, origin: 'subagent', cwd: process.cwd() },
    })
    child.agent.session.append('turn/start', { turn: 1 })
    const decision = test.ctx.approval.request({ agent: child.agent, toolName: 'bash' })
    await vi.waitFor(() => {
      expect(test.terminal.output).toContain('subagent · child-y')
      expect(test.terminal.output).toContain('Allow bash?')
    })
    test.terminal.feed('\r')
    await expect(decision).resolves.toBe('allowed-once')
    await test.app.stop(0)
  })

  it('labels a descendant by its short id when no projection is composed', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const parent = owned(test)
    const child = await test.ctx.agents.create({
      sessionId: SessionId('child-x'),
      parentAgent: parent,
      meta: { parentSession: parent.session.id, origin: 'subagent', cwd: process.cwd() },
    })
    child.agent.session.append('turn/start', { turn: 1 })
    const decision = test.ctx.approval.request({ agent: child.agent, toolName: 'bash' })
    await vi.waitFor(() => {
      expect(test.terminal.output).toContain('subagent · child-x')
      expect(test.terminal.output).toContain('Allow bash?')
    })
    test.terminal.feed('\r')
    await expect(decision).resolves.toBe('allowed-once')
    await test.app.stop(0)
  })

  it('delegates a child whose parent chain is no longer live', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const orphan = await test.ctx.agents.create({
      sessionId: SessionId('orphan-child'),
      meta: {
        parentSession: SessionId('missing-parent'),
        origin: 'subagent',
        delegationDepth: 1,
        cwd: process.cwd(),
      },
    })
    orphan.agent.session.append('turn/start', { turn: 1 })
    const decision = test.ctx.approval.request({ agent: orphan.agent, toolName: 'bash' })
    await expect(decision).resolves.toBe('unavailable')
    expect(test.terminal.output).not.toContain('Allow bash?')
    await test.app.stop(0)
  })

  it('delegates an unrelated root approval instead of prompting', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const other = await test.ctx.agents.create({ sessionId: SessionId('other-root') })
    other.agent.session.append('turn/start', { turn: 1 })
    const decision = test.ctx.approval.request({ agent: other.agent, toolName: 'bash' })
    await expect(decision).resolves.toBe('unavailable')
    expect(test.terminal.output).not.toContain('Allow bash?')
    await test.app.stop(0)
  })

  it('settles a queued prompt whose signal aborts before it opens', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const first = test.app.choose('First', [{ value: 'a', label: 'Alpha' }])
    const controller = new AbortController()
    const second = test.app.choose('Second', [{ value: 'b', label: 'Beta' }], controller.signal)
    controller.abort()
    await vi.waitFor(() => { expect(test.terminal.output).toContain('First') })
    test.terminal.feed('\r')
    await expect(first).resolves.toMatchObject({ kind: 'answer', value: { value: 'a' } })
    await expect(second).resolves.toEqual({ kind: 'cancel' })
    await test.app.stop(0)
  })

  it('ignores a mouse click on a picker and still confirms the keyboard selection', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate' })
    const pending = test.app.choose('Select a model', [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
    ])
    await vi.waitFor(() => { expect(screen(test.app).some(row => row.includes('Select a model'))).toBe(true) })
    const rows = screen(test.app)
    const title = rows.findIndex(row => row.trim() === 'Select a model')
    const option = rows.findIndex((row, index) => index > title && row.includes('Beta'))
    const x = rows[option]!.indexOf('Beta') + 1
    // A press and release on the Beta row settles nothing.
    test.terminal.feed(`\x1b[<0;${x};${option + 1}M`)
    test.terminal.feed(`\x1b[<0;${x};${option + 1}m`)
    test.terminal.feed('\r')
    await expect(pending).resolves.toMatchObject({ kind: 'answer', value: { value: 'a' } })
    await test.app.stop(0)
  })

  it('mounts the alternate-screen layout without a prompt', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate' })
    expect(test.terminal.output).toContain('\x1b[?1049h')
    await test.app.stop(0)
    expect(test.exits).toEqual([0])
  })

  it.each([true, false])('reports native clipboard success=%s after mouse selection', async (success) => {
    const copy = vi.fn(async () => success)
    const test = await bench({
      afterPrompt(session, message) {
        appendAnsweredTurn(session, message, 'COPY-MARKER')
      },
    }, { screen: 'alternate' })
    internals.copyClipboardText = copy
    test.terminal.feed('reply')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(screen(test.app).some(row => row.includes('COPY-MARKER'))).toBe(true) })
    const rows = screen(test.app)
    const y = rows.findIndex(row => row.includes('COPY-MARKER')) + 1
    const x = rows[y - 1]!.indexOf('COPY-MARKER') + 1
    test.terminal.feed(`\x1b[<0;${x};${y}M`)
    test.terminal.feed(`\x1b[<32;${x + 10};${y}M`)
    test.terminal.feed(`\x1b[<0;${x + 10};${y}m`)
    expect(copy).toHaveBeenCalledWith('COPY-MARKER', expect.any(Function))
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain(success ? 'Copied!' : 'Copy failed') })
    expect(test.terminal.output).not.toContain('\x1b]52;')
    copy.mockClear()
    test.terminal.feed('\x1b[99;9u')
    expect(copy).toHaveBeenCalledTimes(1)
    test.terminal.feed('\x1b[99;9:3u')
    expect(copy).toHaveBeenCalledTimes(1)
    expect(test.exits).toEqual([])
    await test.app.stop(0)
  })

  it('ignores Command+C without a selection', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate' })
    test.terminal.feed('\x1b[99;9u')
    expect(test.terminal.output).not.toContain('\x1b]52;')
    expect(test.exits).toEqual([])
    await test.app.stop(0)
  })

  it('restores the transcript to the main screen when an alternate-screen run exits', async () => {
    const test = await bench({
      afterPrompt(session, message) {
        appendAnsweredTurn(session, message, 'RESTORED-TRANSCRIPT-MARKER')
      },
    }, { screen: 'alternate' })
    test.terminal.feed('say the marker')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(test.terminal.output).toContain('RESTORED-TRANSCRIPT-MARKER') })
    // Only the bytes the exit restore writes are under test.
    test.terminal.output = ''
    await test.app.stop(0)
    expect(test.terminal.output).toContain('\x1b[?1049l')
    const restored = plain(test.terminal.output)
    expect(restored).toContain('say the marker')
    expect(restored).toContain('RESTORED-TRANSCRIPT-MARKER')
    expect(test.exits).toEqual([0])
  })

  it('prints the resume command for the session it leaves', async () => {
    const writes: string[] = []
    internals.stderr = { write: (chunk: string) => { writes.push(chunk); return true } }
    const test = await bench({
      afterPrompt(session, message) { appendAnsweredTurn(session, message, 'ok') },
    }, { persistence: true })
    const id = owned(test).session.id
    test.terminal.feed('hello')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('ok') })

    await test.app.stop(0)
    expect(writes.join('')).toBe(`To resume this session:\n  dsh --resume ${id}\n`)
    expect(test.exits).toEqual([0])
  })

  it('names the replacement session after /new replaces the exiting one', async () => {
    const writes: string[] = []
    internals.stderr = { write: (chunk: string) => { writes.push(chunk); return true } }
    const test = await bench({ afterPrompt: () => {} }, { persistence: true })
    const first = owned(test).session.id
    test.terminal.feed('/new')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('started a new session') })
    // The scripted factory's dispose does not unregister the old Agent, so read
    // the live session from the app rather than the registry.
    const replacement = (Reflect.get(test.app, 'session') as { session: { id: string } }).session.id
    expect(replacement).not.toBe(first)

    await test.app.stop(0)
    expect(writes.join('')).toBe(`To resume this session:\n  dsh --resume ${replacement}\n`)
  })

  it.each(['/new', '/resume session-1'])('releases the previous session markdown cache on %s', async (command) => {
    internals.stderr = { write: () => true }
    const test = await bench({
      afterPrompt(session, message) { appendAnsweredTurn(session, message, 'old reply') },
    }, { stored: { sessionId: 'session-1', history: storedTurn('stored prompt', 'stored reply') } })
    test.terminal.feed('hello')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('old reply') })
    const view = Reflect.get(test.app, 'transcriptView') as { markdown: Map<number, { text: string }> }
    const oldIds = [...view.markdown.keys()]
    expect(oldIds.length).toBeGreaterThan(0)
    expect([...view.markdown.values()].map(value => value.text)).toContain('old reply')

    test.terminal.feed(command)
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain(command === '/new' ? 'started a new session' : 'resumed session-1')
    })
    for (const id of oldIds) expect(view.markdown.has(id)).toBe(false)
    if (command === '/new') expect(view.markdown.size).toBe(0)
    else expect([...view.markdown.values()].map(value => value.text)).toEqual(['stored reply'])
    await test.app.stop(0)
  })

  it('omits the resume command when the deployment stores no sessions', async () => {
    const writes: string[] = []
    internals.stderr = { write: (chunk: string) => { writes.push(chunk); return true } }
    const test = await bench({
      afterPrompt(session, message) { appendAnsweredTurn(session, message, 'ok') },
    })
    test.terminal.feed('hello')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('ok') })

    await test.app.stop(0)
    expect(writes).toEqual([])
  })

  it('restores the stored conversation when booting with --resume', async () => {
    internals.stderr = { write: () => true }
    const history = storedTurn('what changed?', 'the parser now accepts it')
    const test = await bench({ afterPrompt: () => {} }, {
      resume: 'session-1',
      stored: { sessionId: 'session-1', history },
    })
    const rendered = plain(test.terminal.output)
    expect(rendered).toContain('what changed?')
    expect(rendered).toContain('the parser now accepts it')
    await test.app.stop(0)
  })

  it('restores the stored conversation when /resume replaces the live session', async () => {
    internals.stderr = { write: () => true }
    const history = storedTurn('earlier prompt', 'earlier reply')
    const test = await bench({ afterPrompt: () => {} }, {
      stored: { sessionId: 'session-1', history },
    })
    expect(plain(test.terminal.output)).not.toContain('earlier prompt')
    test.terminal.feed('/resume session-1')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('resumed session-1') })
    const rendered = plain(test.terminal.output)
    expect(rendered.indexOf('earlier prompt')).toBeGreaterThanOrEqual(0)
    expect(rendered.indexOf('resumed session-1')).toBeGreaterThan(rendered.indexOf('earlier prompt'))
    await test.app.stop(0)
  })

  it('keeps a live event that lands while the resumed history is loading', async () => {
    internals.stderr = { write: () => true }
    const history = storedTurn('stored prompt', 'stored reply')
    const test = await bench({ afterPrompt: () => {} }, {
      resume: 'session-1',
      stored: {
        sessionId: 'session-1',
        history,
        whileReading: (session) => {
          session.append('user/message', createUserMessage({
            content: [{ type: 'text', text: 'live during restore' }],
            source: { kind: 'user' },
          }), { surfaceOp: 'append' })
        },
      },
    })
    const rendered = plain(test.terminal.output)
    expect(rendered).toContain('stored prompt')
    expect(rendered).toContain('live during restore')
    expect(rendered.indexOf('stored prompt')).toBeLessThan(rendered.indexOf('live during restore'))
    await test.app.stop(0)
  })

  it('reports a resumed history the backend cannot read', async () => {
    internals.stderr = { write: () => true }
    const test = await bench({ afterPrompt: () => {} }, {
      stored: { sessionId: 'session-1', history: storedTurn('stored prompt', 'stored reply') },
    })
    test.terminal.feed('/resume missing-session')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('could not restore the session history')
    })
    await test.app.stop(0)
  })

  it('keeps the live session when /resume cannot open the replacement', async () => {
    internals.stderr = { write: () => true }
    const test = await bench({
      afterPrompt(session, message) {
        appendAnsweredTurn(session, message, `reply to ${textOfBlocks(message.content)}`)
      },
    }, { persistence: true, resumeError: 'cannot open the stored session' })
    const live = owned(test)
    test.terminal.feed('first')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(assistantRows(test)).toContain('reply to first') })

    test.terminal.feed('/resume missing-session')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('cannot open the stored session')
    })

    // The rejected open leaves the same Agent subscribed and the rows it folded.
    expect(owned(test)).toBe(live)
    expect(assistantRows(test)).toContain('reply to first')
    // Those subscriptions still deliver: the next turn's reply renders too.
    test.terminal.feed('second')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(assistantRows(test)).toContain('reply to second') })
    await test.app.stop(0)
  })

  it('reports a /resume by id when the deployment stores no sessions', async () => {
    const test = await bench({ afterPrompt: () => {} })
    test.terminal.feed('/resume session-1')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('this deployment stores no sessions') })
    await test.app.stop(0)
  })

  it('reports an empty stored-session list from the resume picker', async () => {
    internals.stderr = { write: () => true }
    const test = await bench({ afterPrompt: () => {} }, { storedList: [] })
    test.terminal.feed('/resume')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('no stored sessions') })
    await test.app.stop(0)
  })

  it('reports the resume picker usage when the deployment stores no sessions', async () => {
    const test = await bench({ afterPrompt: () => {} })
    test.terminal.feed('/resume')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('usage: /resume <session-id>') })
    await test.app.stop(0)
  })

  it('labels the resume picker with each stored session title, newest first', async () => {
    internals.stderr = { write: () => true }
    const test = await bench({ afterPrompt: () => {} }, {
      screen: 'alternate',
      storedList: [
        { id: 'session-older', createdAt: Date.UTC(2026, 0, 2, 3, 4), cwd: '/work/older', title: 'Fix the parser' },
        { id: 'session-newer', createdAt: Date.UTC(2026, 0, 3, 3, 4), cwd: '/work/newer', title: 'Add resume labels' },
      ],
    })
    test.terminal.feed('/resume')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(screen(test.app).some(row => row.includes('Add resume labels'))).toBe(true) })

    const rows = screen(test.app)
    const newest = rows.find(row => row.includes('Add resume labels'))
    expect(newest).toContain('2026-01-03 03:04')
    expect(newest).toContain('/work/newer')
    // The stored order is newer first, and each row keeps a readable title.
    expect(rows.findIndex(row => row.includes('Add resume labels')))
      .toBeLessThan(rows.findIndex(row => row.includes('Fix the parser')))

    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('resumed session-newer') })
    await test.app.stop(0)
  })

  it('falls back to the short id for a stored session without a readable title', async () => {
    internals.stderr = { write: () => true }
    const test = await bench({ afterPrompt: () => {} }, {
      screen: 'alternate',
      storedList: [
        { id: 'session-00000000-0000-4000-8000-000000000001', createdAt: 0, cwd: '/work/empty' },
        {
          id: 'session-00000000-0000-4000-8000-000000000002',
          createdAt: 0,
          titleFailure: true,
        },
      ],
    })
    test.terminal.feed('/resume')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(screen(test.app).some(row => row.includes('000000000001'))).toBe(true) })

    const rows = screen(test.app)
    const untitled = rows.find(candidate => candidate.includes('000000000001'))
    expect(untitled).toContain('1970-01-01 00:00')
    expect(untitled).toContain('/work/empty')
    expect(rows.some(candidate => candidate.includes('000000000002'))).toBe(true)
    // The second row has no workspace, so its row keeps the explicit empty detail.
    expect(rows.find(candidate => candidate.includes('000000000002'))).toContain('(no workspace)')
    await test.app.stop(0)
  })

  it('lists stored sessions by short id when the deployment mounts no session query', async () => {
    internals.stderr = { write: () => true }
    const test = await bench({ afterPrompt: () => {} }, {
      withoutSessionQuery: true,
      storedList: [
        { id: 'session-00000000-0000-4000-8000-000000000003', createdAt: 0, cwd: '/work/plain', title: 'Unused title' },
      ],
    })
    test.terminal.feed('/sessions')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('000000000003') })
    expect(plain(test.terminal.output)).toContain('/work/plain')
    expect(plain(test.terminal.output)).not.toContain('Unused title')
    await test.app.stop(0)
  })

  it('lists stored sessions by title in /sessions', async () => {
    internals.stderr = { write: () => true }
    const test = await bench({ afterPrompt: () => {} }, {
      storedList: [
        { id: 'session-older', createdAt: Date.UTC(2026, 0, 2, 3, 4), cwd: '/work/older', title: 'Fix the parser' },
        { id: 'session-untitled', createdAt: Date.UTC(2026, 0, 1, 3, 4), cwd: '/work/untitled' },
      ],
    })
    test.terminal.feed('/sessions')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('Fix the parser') })
    expect(plain(test.terminal.output)).toContain('/work/older')
    expect(plain(test.terminal.output)).toContain('/work/untitled')
    await test.app.stop(0)
  })

  it('rejects a /resume that names the live session instead of reopening it', async () => {
    internals.stderr = { write: () => true }
    const test = await bench({ afterPrompt: () => {} }, { persistence: true })
    const live = owned(test)
    const id = String(live.session.id)
    test.terminal.feed(`/resume ${id}`)
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain(`already on session ${id}`) })
    expect(owned(test)).toBe(live)
    await test.app.stop(0)
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
    await expect(pending).resolves.toMatchObject({ kind: 'answer', value: { value: 'deepseek-official/deepseek-flash' } })
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
    await expect(pending).resolves.toMatchObject({ kind: 'answer', value: { value: route } })
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
    await expect(pending).resolves.toMatchObject({ kind: 'answer', value: { value: 'model-0' } })
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
    const test = await bench({ afterPrompt: () => {} })
    expect(plain(test.terminal.output)).toContain('Enter send')
    expect(plain(test.terminal.output)).not.toContain('%')
    await test.app.stop(0)
  })

  it('reports whole-log throughput, total tokens, and cache hits in the footer', async () => {
    const test = await bench({ afterPrompt: () => {} }, { tokenMeter: true, sessionStats: true })
    expect(plain(test.terminal.output)).not.toContain('tok/s')
    const session = test.ctx.agents.list()[0]!.session
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      stream: [{
        type: 'chunk',
        time: Date.now() - 3_000,
        chunk: { type: 'text-delta', index: 0, text: 'done' },
      }],
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 0 },
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'done' }],
        source: { provider: 'test-provider', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' })
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('90% cache') })
    const rendered = plain(test.terminal.output)
    expect(rendered).toContain('1.1k tok')
    expect(rendered).toContain('tok/s')
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
      config: { screen: 'inline', colorScheme: 'auto' },
      cwd: process.cwd(),
      invocation: {},
      exit: () => {},
    })).rejects.toThrow(/interactive terminal/)
  })
})

describe('TuiApp tool diffs', () => {
  it('renders a mutation through the Host diff presenter it resolves from the registry', async () => {
    const test = await bench({
      afterPrompt(session, message) {
        const turn = session.seq + 1
        const callId = 'call-edit' as ToolCallId
        session.append('turn/start', { turn })
        session.append('step/start', { turn, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('assistant/message', {
          turn,
          step: 1,
          stream: [],
          message: createAssistantMessage({
            content: [{ type: 'text', text: 'Editing now.' }],
            source: { provider: 'test-provider', model: 'test-model' },
          }),
        }, { surfaceOp: 'append' })
        session.append('tool/call', {
          turn,
          step: 1,
          callId,
          name: 'edit',
          arguments: JSON.stringify({ file_path: 'a.ts', old_string: 'old', new_string: 'new' }),
        })
        session.append('tool/result', {
          turn,
          step: 1,
          message: createToolResultMessage({
            callId,
            content: [{ type: 'text', text: 'The file a.ts has been updated successfully.' }],
            isError: false,
          }),
          meta: { diffs: [{ path: 'a.ts', oldText: 'ctx\nold', newText: 'ctx\nnew' }] },
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn, step: 1 })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      },
    }, { tools: true })
    test.ctx.tools.register(defineTool({
      name: 'edit',
      description: 'Stub edit over the real registry.',
      parameters: {
        file_path: { type: 'string', required: true },
        old_string: { type: 'string', required: true },
        new_string: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: () => Promise.resolve('updated'),
      presentCall: args => ({
        card: 'diff',
        title: `Edit ${args.file_path}`,
        diffs: [{ path: args.file_path, oldText: args.old_string, newText: args.new_string }],
      }),
      presentResult: (_args, result) => ({
        card: 'diff',
        title: 'Edit a.ts',
        diffs: (result.meta as { diffs?: FileDiff[] } | undefined)?.diffs ?? [],
      }),
    }))
    test.terminal.feed('edit the file')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('Edit a.ts') })
    const rendered = plain(test.terminal.output)
    expect(rendered).toContain('- old')
    expect(rendered).toContain('+ new')
    expect(rendered).toContain('+1')
    expect(rendered).toContain('-1')
    expect(rendered).not.toContain('has been updated successfully')
    await test.app.stop(0)
  })

  it('renders a terminal card through the Host presenter it resolves from the registry', async () => {
    const test = await bench({
      afterPrompt(session, message) {
        const turn = session.seq + 1
        const callId = 'call-run' as ToolCallId
        session.append('turn/start', { turn })
        session.append('step/start', { turn, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('assistant/message', {
          turn,
          step: 1,
          stream: [],
          message: createAssistantMessage({
            content: [{ type: 'text', text: 'Running now.' }],
            source: { provider: 'test-provider', model: 'test-model' },
          }),
        }, { surfaceOp: 'append' })
        session.append('tool/call', {
          turn,
          step: 1,
          callId,
          name: 'run',
          arguments: JSON.stringify({ command: 'run --now' }),
        })
        session.append('tool/result', {
          turn,
          step: 1,
          message: createToolResultMessage({
            callId,
            content: [{ type: 'text', text: 'done\n[exit code: 3]' }],
            isError: false,
          }),
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn, step: 1 })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      },
    }, { tools: true })
    test.ctx.tools.register(defineTool({
      name: 'run',
      description: 'Stub terminal over the real registry.',
      parameters: { command: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: () => Promise.resolve('done'),
      presentCall: args => ({ card: 'terminal', title: args.command, cwd: '/work' }),
      presentResult: () => ({ card: 'terminal', output: 'done', exitCode: 3 }),
    }))
    test.terminal.feed('run it')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('exit 3') })
    const rendered = plain(test.terminal.output)
    expect(rendered).toContain('run --now')
    expect(rendered).toContain('/work')
    expect(rendered).not.toContain('exit code: 3')
    await test.app.stop(0)
  })
})

describe('TuiApp plan mode', () => {
  /** Shift+Tab as a legacy terminal reports it. */
  const SHIFT_TAB = '\x1b[Z'

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
    await expect(pending).resolves.toEqual({ kind: 'skip' })
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

  it('keeps Shift+Tab working after /new replaces the session', async () => {
    const test = await bench({ afterPrompt: () => {} }, { planMode: true })
    test.terminal.feed('/new')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('started a new session') })

    test.terminal.feed(SHIFT_TAB)
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('plan mode on') })
    await test.app.stop(0)
  })
})

describe('TuiApp boot selection', () => {
  it('requires the launcher and startup services before selecting a surface', () => {
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => { apply(ctx, { screen: 'inline', colorScheme: 'auto' }) }).toThrow('launcher must provide ctx.appExit')
    ctx.provide('appExit', () => {})
    expect(() => { apply(ctx, { screen: 'inline', colorScheme: 'auto' }) }).toThrow('startup provider must publish tuiStartup')
  })

  it('boots the watch surface for a watch invocation', () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('appExit', () => {})
    ctx.provide(TUI_STARTUP_SERVICE, { watch: 'child-1' })
    const boot = vi.spyOn(WatchApp, 'boot').mockResolvedValue({} as WatchApp)
    try {
      apply(ctx, { screen: 'inline', colorScheme: 'auto' })
      expect(boot).toHaveBeenCalledWith(expect.objectContaining({ watch: 'child-1' }))
    } finally {
      boot.mockRestore()
    }
  })

  it('reports a non-Error boot rejection through stderr and the launcher exit', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const exits: number[] = []
    let written = ''
    internals.stderr = { write: (chunk: string) => { written += chunk; return true } }
    ctx.provide('appExit', (code: number) => { exits.push(code) })
    ctx.provide(TUI_STARTUP_SERVICE, {})
    const boot = vi.spyOn(TuiApp, 'boot').mockRejectedValue('boot failed')
    try {
      apply(ctx, { screen: 'inline', colorScheme: 'auto' })
      await vi.waitFor(() => { expect(written).toContain('dsh: boot failed') })
      expect(exits).toEqual([1])
    } finally {
      boot.mockRestore()
    }
  })

  it('reports a rejected interactive boot through stderr and the launcher exit', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const exits: number[] = []
    let written = ''
    internals.stderr = { write: (chunk: string) => { written += chunk; return true } }
    ctx.provide('appExit', (code: number) => { exits.push(code) })
    ctx.provide(TUI_STARTUP_SERVICE, {})
    const boot = vi.spyOn(TuiApp, 'boot').mockRejectedValue(new Error('boot failed'))
    try {
      apply(ctx, { screen: 'inline', colorScheme: 'auto' })
      await vi.waitFor(() => { expect(written).toContain('dsh: boot failed') })
      expect(exits).toEqual([1])
      expect(boot).toHaveBeenCalled()
    } finally {
      boot.mockRestore()
    }
  })
})

describe('TuiApp as a Cordis plugin', () => {
  it('accesses model routes and remembers approvals from its plugin context', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(UserApprovalService)
    ctx.agents.setFactory({
      async createAgent(ownerCtx: Context, createOptions: CreateAgentOptions): Promise<AgentHandle> {
        const session = ctx.sessions.create(createOptions.sessionId)
        const agent: Agent = {
          id: session.id,
          options: createOptions.agentOptions ?? {},
          model: createAgentModel(createOptions.agentOptions ?? {}),
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
    await ctx.plugin({ name, inject, apply }, { screen: 'inline', colorScheme: 'auto' })
    await vi.waitFor(() => { expect(terminal.output).toContain('/help commands') })
    terminal.feed('/model')
    terminal.feed('\r')
    await vi.waitFor(() => { expect(terminal.output).toContain('no model route is registered') })
    expect(inject).toContain('llm')
    expect(terminal.output).not.toContain('without inject')

    const agent = ctx.agents.list()[0]!
    agent.session.append('turn/start', { turn: 1 })
    const once = ctx.approval.request({ agent, toolName: 'read_file' })
    await vi.waitFor(() => { expect(terminal.output).toContain('Allow read_file?') })
    terminal.feed('\r')
    await expect(once).resolves.toBe('allowed-once')
    expect(ctx.approval.isGranted(agent, 'read_file')).toBe(false)

    terminal.output = ''
    const always = ctx.approval.request({ agent, toolName: 'bash' })
    await vi.waitFor(() => { expect(terminal.output).toContain('Always allow bash') })
    terminal.feed('\x1b[B')
    terminal.feed('\r')
    await expect(always).resolves.toBe('allowed-once')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'approval/grant'))
      .toMatchObject([{ data: { toolName: 'bash' } }])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'approval/decided').at(-1)?.data)
      .toMatchObject({ outcome: 'allowed-once', remembered: true })
    await expect(ctx.approval.request({ agent, toolName: 'bash' })).resolves.toBe('allowed-once')
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
    await expect(first).resolves.toEqual({ kind: 'answer', value: 'typed' })
    await vi.waitFor(() => { expect(test.terminal.output).toContain('second?') })
    test.terminal.feed('\r')
    await expect(second).resolves.toMatchObject({ kind: 'answer', value: { value: 'ok' } })
    await test.app.stop(0)
  })
})

describe('TuiApp question detail', () => {
  it('renders the plan a review carries and approves it', async () => {
    const test = await bench({ afterPrompt: () => {} }, { planMode: true, questions: true, screen: 'alternate' })
    const agent = owned(test)
    test.ctx.planMode.set(agent, true)
    const plan = '# Widget migration\n\nMove the widget to its own module.\n\nThen update every caller.'
    const execution = executeTool(test.ctx, agent, { id: ToolCallId('call-exit-1'), name: 'exit_plan_mode', arguments: { plan } })
    // The review shares the plan verbatim: the model is told not to repeat it
    // as a plain reply, so an unrendered detail would leave nothing to review.
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('Widget migration'))).toBe(true)
    })
    expect(screen(test.app).some(row => row.includes('Move the widget'))).toBe(true)
    expect(screen(test.app).some(row => row.includes('→ Approve'))).toBe(true)

    test.terminal.feed('\r')
    await expect(execution).resolves.toMatchObject({ isError: false, value: { approved: true } })
    await test.app.stop(0)
  })

  it('skips a plan review on Escape and hands the turn back', async () => {
    const test = await bench({ afterPrompt: () => {} }, { planMode: true, questions: true, screen: 'alternate' })
    const agent = owned(test)
    test.ctx.planMode.set(agent, true)
    const execution = executeTool(test.ctx, agent, { id: ToolCallId('call-exit-skip'), name: 'exit_plan_mode', arguments: { plan: '# Widget migration\n\nMove the widget.' } })
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ Approve'))).toBe(true)
    })
    test.terminal.feed('\x1b')
    await expect(execution).resolves.toMatchObject({ isError: false, value: { approved: false } })
    await test.app.stop(0)
  })

  it('sends the plan review feedback typed in the Other row', async () => {
    const test = await bench({ afterPrompt: () => {} }, { planMode: true, questions: true, screen: 'alternate' })
    const agent = owned(test)
    test.ctx.planMode.set(agent, true)
    const execution = executeTool(test.ctx, agent, { id: ToolCallId('call-exit-other'), name: 'exit_plan_mode', arguments: { plan: '# Widget migration\n\nMove the widget.' } })
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ Approve'))).toBe(true)
    })
    // Approve, Keep planning, then the appended Other row.
    test.terminal.feed('\x1b[B')
    test.terminal.feed('\x1b[B')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ Other…'))).toBe(true)
    })
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      // The plan renders between the heading and the input it replaced the list with.
      const frame = screen(test.app)
      const heading = frame.findIndex(row => row.includes('Approve this plan'))
      const composer = frame.findIndex(row => row.includes('Enter send'))
      const input = frame.findIndex((row, index) => index > heading && index < composer && row.startsWith('> '))
      expect(input).toBeGreaterThan(heading)
    })
    test.terminal.feed('shrink it')
    test.terminal.feed('\r')
    await expect(execution).resolves.toMatchObject({ isError: true })
    expect(JSON.stringify((await execution).content)).toContain('shrink it')
    await test.app.stop(0)
  })

  it('hands the turn back when the plan review note is skipped', async () => {
    const test = await bench({ afterPrompt: () => {} }, { planMode: true, questions: true, screen: 'alternate' })
    const agent = owned(test)
    test.ctx.planMode.set(agent, true)
    const execution = executeTool(test.ctx, agent, { id: ToolCallId('call-exit-note-skip'), name: 'exit_plan_mode', arguments: { plan: '# Widget migration\n\nMove the widget.' } })
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ Approve'))).toBe(true)
    })
    test.terminal.feed('\x1b[B')
    test.terminal.feed('\x1b[B')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ Other…'))).toBe(true)
    })
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      const frame = screen(test.app)
      const heading = frame.findIndex(row => row.includes('Approve this plan'))
      const composer = frame.findIndex(row => row.includes('Enter send'))
      expect(frame.findIndex((row, index) => index > heading && index < composer && row.startsWith('> '))).toBeGreaterThan(heading)
    })
    test.terminal.feed('\x1b')
    await expect(execution).resolves.toMatchObject({ isError: false, value: { approved: false } })
    await test.app.stop(0)
  })

  it('hands the turn back when the plan review note is empty', async () => {
    const test = await bench({ afterPrompt: () => {} }, { planMode: true, questions: true, screen: 'alternate' })
    const agent = owned(test)
    test.ctx.planMode.set(agent, true)
    const execution = executeTool(test.ctx, agent, { id: ToolCallId('call-exit-note-empty'), name: 'exit_plan_mode', arguments: { plan: '# Widget migration\n\nMove the widget.' } })
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ Approve'))).toBe(true)
    })
    test.terminal.feed('\x1b[B')
    test.terminal.feed('\x1b[B')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ Other…'))).toBe(true)
    })
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      const frame = screen(test.app)
      const heading = frame.findIndex(row => row.includes('Approve this plan'))
      const composer = frame.findIndex(row => row.includes('Enter send'))
      expect(frame.findIndex((row, index) => index > heading && index < composer && row.startsWith('> '))).toBeGreaterThan(heading)
    })
    test.terminal.feed('\r')
    await expect(execution).resolves.toMatchObject({ isError: false, value: { approved: false } })
    await test.app.stop(0)
  })

  it('scrolls a plan with the arrows and keeps planning without sending the model back', async () => {
    const test = await bench({ afterPrompt: () => {} }, { planMode: true, questions: true, screen: 'alternate' })
    const agent = owned(test)
    test.ctx.planMode.set(agent, true)
    const plan = `# Widget migration\n\n${Array.from(
      { length: 30 },
      (_, index) => `Step ${String(index + 1).padStart(2, '0')} of the migration.`,
    ).join('\n\n')}`
    const execution = executeTool(test.ctx, agent, { id: ToolCallId('call-exit-2'), name: 'exit_plan_mode', arguments: { plan } })
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('Step 01'))).toBe(true)
    })
    // A detail takes the rows above the pinned footer rather than the 18-row
    // picker cap, so a tall terminal shows a tall plan.
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('1–16/'))).toBe(true)
    })
    const frame = screen(test.app)
    const title = frame.findIndex(row => row.includes('Approve this plan'))
    const composer = frame.findIndex(row => row.includes('Enter send'))
    expect(composer - 1 - title).toBeGreaterThan(18)
    const before = frame.findIndex(row => row.includes('scroll'))
    expect(before).toBeGreaterThanOrEqual(0)

    // A long plan owns Up/Down; the first press scrolls the detail instead of
    // moving the Approve / Keep planning selection.
    test.terminal.feed('\x1b[B')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('2–'))).toBe(true)
    })
    expect(screen(test.app).some(row => row.includes('→ Approve'))).toBe(true)

    // Left/Right moves the selection while the plan owns the arrows.
    test.terminal.feed('\x1b[C')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ Keep planning'))).toBe(true)
    })
    test.terminal.feed('\r')

    // Keep planning hands the turn back: a dismissed review is an
    // unsuccessful approval rather than a failed tool, so the turn concludes
    // and the user's next message starts the following request.
    await expect(execution).resolves.toMatchObject({ isError: false })
    const result = await execution
    expect(result.content).toEqual([{
      type: 'text',
      text: 'The user dismissed the plan review to reply in their own words; plan mode remains active.',
    }])
    await test.app.stop(0)
  })

  it('scrolls a question detail longer than the panel', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    const detail = Array.from({ length: 40 }, (_, index) => `marker-${String(index + 1).padStart(2, '0')}`).join('\n\n')
    const pending = test.ctx.userQuestions.ask({
      questions: [{
        id: 'detail',
        question: 'Pick one',
        detail,
        options: [{ label: 'Alpha' }, { label: 'Beta' }],
      }],
      agent,
    })
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('marker-01'))).toBe(true)
    })
    expect(screen(test.app).some(row => row.includes('marker-40'))).toBe(false)

    for (let press = 0; press < 8; press += 1) test.terminal.feed('\x1b[6~')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('marker-40'))).toBe(true)
    })
    expect(screen(test.app).some(row => row.includes('marker-01'))).toBe(false)

    // A theme or cell-size change invalidates every component; the review must
    // redraw its cached detail instead of losing it.
    ;(Reflect.get(test.app, 'tui') as { invalidate(): void }).invalidate()
    for (let press = 0; press < 8; press += 1) test.terminal.feed('\x1b[5~')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('marker-01'))).toBe(true)
    })

    test.terminal.feed('\r')
    await expect(pending).resolves.toMatchObject({ answers: [{ id: 'detail', selected: ['Alpha'] }] })
    await test.app.stop(0)
  })

  it('keeps arrow selection when a short detail fits above the picker', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    const pending = test.ctx.userQuestions.ask({
      questions: [{
        id: 'short',
        question: 'Pick one',
        detail: 'Context: one line.',
        options: [{ label: 'Alpha' }, { label: 'Beta' }],
      }],
      agent,
    })
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ Alpha'))).toBe(true)
    })
    // The detail fits, so Up/Down keep their ordinary picker meaning.
    test.terminal.feed('\x1b[B')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ Beta'))).toBe(true)
    })
    test.terminal.feed('\r')
    await expect(pending).resolves.toMatchObject({ answers: [{ id: 'short', selected: ['Beta'] }] })
    await test.app.stop(0)
  })

  it('pages the transcript with the wheel while a question waits', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate' })
    appendScrollback(owned(test).session, 20)
    const pending = test.app.choose('Select a model', [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
    ])
    await vi.waitFor(() => { expect(screen(test.app).some(row => row.includes('→ Alpha'))).toBe(true) })
    expect(screen(test.app).some(row => row.includes('PROMPT-01'))).toBe(false)
    const option = screen(test.app).findIndex(row => row.includes('→ Alpha')) + 1
    // A wheel over the picker pages the history behind it; the highlight stays put.
    for (let notch = 0; notch < 60; notch += 1) test.terminal.feed(`\x1b[<64;5;${String(option)}M`)
    await vi.waitFor(() => { expect(screen(test.app).some(row => row.includes('PROMPT-01'))).toBe(true) })
    expect(screen(test.app).some(row => row.includes('→ Alpha'))).toBe(true)
    for (let notch = 0; notch < 60; notch += 1) test.terminal.feed(`\x1b[<65;5;${String(option)}M`)
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('PROMPT-01'))).toBe(false)
      expect(screen(test.app).some(row => row.includes('PROMPT-19'))).toBe(true)
    })
    test.terminal.feed('\r')
    await expect(pending).resolves.toMatchObject({ kind: 'answer', value: { value: 'a' } })
    await test.app.stop(0)
  })

  it('pages the transcript with the wheel over a question whose detail fits', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    appendScrollback(agent.session, 20)
    const pending = test.ctx.userQuestions.ask({
      questions: [{
        id: 'short',
        question: 'Pick one',
        detail: 'Context: one line.',
        options: [{ label: 'Alpha' }, { label: 'Beta' }],
      }],
      agent,
    })
    await vi.waitFor(() => { expect(screen(test.app).some(row => row.includes('→ Alpha'))).toBe(true) })
    const option = screen(test.app).findIndex(row => row.includes('→ Alpha')) + 1
    for (let notch = 0; notch < 60; notch += 1) test.terminal.feed(`\x1b[<64;5;${String(option)}M`)
    await vi.waitFor(() => { expect(screen(test.app).some(row => row.includes('PROMPT-01'))).toBe(true) })
    test.terminal.feed('\r')
    await expect(pending).resolves.toMatchObject({ answers: [{ id: 'short', selected: ['Alpha'] }] })
    await test.app.stop(0)
  })

  it('pages the transcript with the wheel from the history above a question', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate' })
    appendScrollback(owned(test).session, 20)
    const pending = test.app.choose('Select a model', [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
    ])
    await vi.waitFor(() => { expect(screen(test.app).some(row => row.includes('→ Alpha'))).toBe(true) })
    // The pointer sits outside the panel, over the transcript the wheel pages.
    for (let notch = 0; notch < 60; notch += 1) test.terminal.feed('\x1b[<64;5;1M')
    await vi.waitFor(() => { expect(screen(test.app).some(row => row.includes('PROMPT-01'))).toBe(true) })
    test.terminal.feed('\x03')
    await expect(pending).resolves.toMatchObject({ kind: 'cancel' })
    await test.app.stop(0)
  })

  it('fails a cancelled question with the seam abort code', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    const pending = test.ctx.userQuestions.ask({
      questions: [{ id: 'plain', question: 'Pick one', options: [{ label: 'Alpha' }] }],
      agent,
    })
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ Alpha'))).toBe(true)
    })
    test.terminal.feed('\x03')
    await expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await test.app.stop(0)
  })

  it('skips a question on Escape and advances the batch', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    const pending = test.ctx.userQuestions.ask({
      questions: [
        { id: 'first', question: 'Pick one', options: [{ label: 'Alpha' }] },
        { id: 'second', question: 'Pick another', options: [{ label: 'Beta' }] },
      ],
      agent,
    })
    await vi.waitFor(() => {
      const frame = screen(test.app)
      expect(frame.some(row => row.trim() === '1/2')).toBe(true)
      expect(frame.some(row => row.trim() === 'Pick one')).toBe(true)
    })
    test.terminal.feed('\x1b')
    await vi.waitFor(() => {
      const frame = screen(test.app)
      expect(frame.some(row => row.trim() === '2/2')).toBe(true)
      expect(frame.some(row => row.trim() === 'Pick another')).toBe(true)
    })
    test.terminal.feed('\r')
    await expect(pending).resolves.toMatchObject({
      answers: [{ id: 'first', selected: [] }, { id: 'second', selected: ['Beta'] }],
    })
    await test.app.stop(0)
  })

  it('answers a question with free text typed in the Other row', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    const pending = test.ctx.userQuestions.ask({
      questions: [{ id: 'free', question: 'Pick one', options: [{ label: 'Alpha' }] }],
      agent,
    })
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ Alpha'))).toBe(true)
    })
    // Alpha carries the highlight, so the appended row is one press below it.
    test.terminal.feed('\x1b[B')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ Other…'))).toBe(true)
    })
    test.terminal.feed('\r')
    // Choosing Other… replaces the option list with the free-text input.
    await vi.waitFor(() => {
      const frame = screen(test.app)
      const heading = frame.findIndex(row => row.trim() === 'Pick one')
      expect(frame[heading + 2]?.startsWith('> ')).toBe(true)
    })
    test.terminal.feed('neither')
    test.terminal.feed('\r')
    await expect(pending).resolves.toMatchObject({
      answers: [{ id: 'free', selected: [], custom: 'neither' }],
    })
    await test.app.stop(0)
  })

  it('shows a no-option question detail above the text input', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    const pending = test.ctx.userQuestions.ask({
      questions: [{ id: 'free', question: 'Why?', detail: 'Context: the widget moved.' }],
      agent,
    })
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('the widget moved'))).toBe(true)
    })
    test.terminal.feed('because')
    test.terminal.feed('\r')
    await expect(pending).resolves.toMatchObject({ answers: [{ id: 'free', selected: [], custom: 'because' }] })
    await test.app.stop(0)
  })

  it('skips a free-text question on Escape and cancels it on Ctrl+C', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    const skipped = test.ctx.userQuestions.ask({ questions: [{ id: 'free', question: 'Why?' }], agent })
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('Why?'))).toBe(true)
    })
    test.terminal.feed('\x1b')
    await expect(skipped).resolves.toMatchObject({ answers: [{ id: 'free', selected: [] }] })

    const cancelled = test.ctx.userQuestions.ask({ questions: [{ id: 'free', question: 'Why?' }], agent })
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('Why?'))).toBe(true)
    })
    test.terminal.feed('\x03')
    await expect(cancelled).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await test.app.stop(0)
  })

  it('submits an empty free-text answer as an empty selection', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    const pending = test.ctx.userQuestions.ask({ questions: [{ id: 'free', question: 'Why?' }], agent })
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('Why?'))).toBe(true)
    })
    test.terminal.feed('\r')
    await expect(pending).resolves.toMatchObject({ answers: [{ id: 'free', selected: [] }] })
    await test.app.stop(0)
  })
})

describe('TuiApp question presentation', () => {
  it('renders a settled ask_user_question row as questions and answers, not result JSON', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, tools: true, screen: 'alternate' })
    await test.ctx.plugin(AskUserTool, { mode: 'timed', timeout: -1 })
    const agent = owned(test)
    agent.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: ToolCallId('call-present'),
      name: 'ask_user_question',
      arguments: JSON.stringify({
        questions: [
          {
            id: 'color',
            header: 'Pick one',
            question: 'Which color do you prefer?',
            options: [{ label: 'Blue' }, { label: 'Green' }],
            multi_select: true,
          },
          { id: 'size', question: 'Which size?' },
        ],
      }),
    })
    await vi.waitFor(() => {
      const frame = screen(test.app)
      expect(frame.some(row => row.includes('Which color do you prefer?'))).toBe(true)
      expect(frame.some(row => row.includes('questions=['))).toBe(false)
    })
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('call-present'),
        content: [{
          type: 'text',
          text: JSON.stringify({
            answers: [
              { id: 'color', selected: ['Blue', 'Green'] },
              { id: 'size', selected: [], custom: 'large' },
            ],
          }),
        }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    await vi.waitFor(() => {
      const frame = screen(test.app)
      expect(frame.some(row => row.includes('2 of 2 answered'))).toBe(true)
      expect(frame.some(row => row.includes('→ Blue, Green'))).toBe(true)
      expect(frame.some(row => row.includes('→ large'))).toBe(true)
      expect(frame.some(row => row.includes('"selected"'))).toBe(false)
    })
    await test.app.stop(0)
  })
})

describe('TuiApp multi-select questions', () => {
  it('checks several options and answers with them in list order', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    const pending = test.ctx.userQuestions.ask({
      questions: [{
        id: 'multi',
        question: 'Pick some',
        multiSelect: true,
        options: [
          { label: 'Alpha' },
          { label: 'Beta', description: 'The second one.' },
          { label: 'Gamma' },
        ],
      }],
      agent,
    })
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ [ ] Alpha'))).toBe(true)
    })
    expect(screen(test.app).some(row => row.includes('Space toggle · Enter confirm'))).toBe(true)
    expect(screen(test.app).join('\n')).not.toContain('one choice per prompt')

    test.terminal.feed(' ')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ [x] Alpha'))).toBe(true)
    })
    // Beta is checked and then unchecked; Gamma stays checked only until the
    // second Space, so the answer carries Alpha and Beta in list order.
    test.terminal.feed('\x1b[B')
    test.terminal.feed(' ')
    test.terminal.feed('\x1b[B')
    test.terminal.feed(' ')
    test.terminal.feed(' ')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ [ ] Gamma'))).toBe(true)
    })
    test.terminal.feed('\r')
    await expect(pending).resolves.toMatchObject({ answers: [{ id: 'multi', selected: ['Alpha', 'Beta'] }] })
    await test.app.stop(0)
  })

  it('keeps the prompt open when Enter confirms nothing checked', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    const pending = test.ctx.userQuestions.ask({
      questions: [{ id: 'multi', question: 'Pick some', multiSelect: true, options: [{ label: 'Alpha' }, { label: 'Beta' }] }],
      agent,
    })
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ [ ] Alpha'))).toBe(true)
    })
    test.terminal.feed('\r')
    expect(screen(test.app).some(row => row.includes('→ [ ] Alpha'))).toBe(true)
    test.terminal.feed(' ')
    test.terminal.feed('\r')
    await expect(pending).resolves.toMatchObject({ answers: [{ id: 'multi', selected: ['Alpha'] }] })
    await test.app.stop(0)
  })

  it('skips a multi-select question on Escape', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    const pending = test.ctx.userQuestions.ask({
      questions: [{ id: 'multi', question: 'Pick some', multiSelect: true, options: [{ label: 'Alpha' }, { label: 'Beta' }] }],
      agent,
    })
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ [ ] Alpha'))).toBe(true)
    })
    test.terminal.feed('\x1b')
    await expect(pending).resolves.toMatchObject({ answers: [{ id: 'multi', selected: [] }] })
    await test.app.stop(0)
  })

  it('adds free text to a multi-select answer through the Other row', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    const pending = test.ctx.userQuestions.ask({
      questions: [{ id: 'multi', question: 'Pick some', multiSelect: true, options: [{ label: 'Alpha' }, { label: 'Beta' }] }],
      agent,
    })
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ [ ] Alpha'))).toBe(true)
    })
    // Check Alpha, move onto the appended Other row, and check it too.
    test.terminal.feed(' ')
    test.terminal.feed('\x1b[B')
    test.terminal.feed('\x1b[B')
    test.terminal.feed(' ')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      const frame = screen(test.app)
      const heading = frame.findIndex(row => row.trim() === 'Pick some')
      expect(frame[heading + 2]?.startsWith('> ')).toBe(true)
    })
    test.terminal.feed('plus')
    test.terminal.feed('\r')
    await expect(pending).resolves.toMatchObject({
      answers: [{ id: 'multi', selected: ['Alpha'], custom: 'plus' }],
    })
    await test.app.stop(0)
  })

  it('keeps the checked options when the Other note is skipped', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    const pending = test.ctx.userQuestions.ask({
      questions: [{ id: 'multi', question: 'Pick some', multiSelect: true, options: [{ label: 'Alpha' }, { label: 'Beta' }] }],
      agent,
    })
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ [ ] Alpha'))).toBe(true)
    })
    test.terminal.feed(' ')
    test.terminal.feed('\x1b[B')
    test.terminal.feed('\x1b[B')
    test.terminal.feed(' ')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      const frame = screen(test.app)
      const heading = frame.findIndex(row => row.trim() === 'Pick some')
      expect(frame[heading + 2]?.startsWith('> ')).toBe(true)
    })
    test.terminal.feed('\x1b')
    await expect(pending).resolves.toMatchObject({ answers: [{ id: 'multi', selected: ['Alpha'] }] })
    await test.app.stop(0)
  })

  it('scrolls a multi-select detail and moves the picker with Left/Right', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    const detail = Array.from({ length: 40 }, (_, index) => `marker-${String(index + 1).padStart(2, '0')}`).join('\n\n')
    const pending = test.ctx.userQuestions.ask({
      questions: [{
        id: 'multi',
        question: 'Pick some',
        multiSelect: true,
        detail,
        options: [{ label: 'Alpha' }, { label: 'Beta' }],
      }],
      agent,
    })
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('marker-01'))).toBe(true)
    })
    // The overflowing detail owns Up/Down; the first press scrolls it.
    test.terminal.feed('\x1b[B')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('2–'))).toBe(true)
    })
    expect(screen(test.app).some(row => row.includes('→ [ ] Alpha'))).toBe(true)
    // Left/Right move the picker while the detail owns the arrows.
    test.terminal.feed('\x1b[C')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ [ ] Beta'))).toBe(true)
    })
    test.terminal.feed(' ')
    test.terminal.feed('\r')
    await expect(pending).resolves.toMatchObject({ answers: [{ id: 'multi', selected: ['Beta'] }] })
    await test.app.stop(0)
  })

  it('cancels a multi-select question with the seam abort code', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    const pending = test.ctx.userQuestions.ask({
      questions: [{ id: 'multi', question: 'Pick some', multiSelect: true, options: [{ label: 'Alpha' }] }],
      agent,
    })
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ [ ] Alpha'))).toBe(true)
    })
    test.terminal.feed('\x03')
    await expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await test.app.stop(0)
  })

  it('scrolls a multi-select picker longer than the panel budget', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate' })
    const items = Array.from({ length: 20 }, (_, index) => ({ value: `opt-${String(index)}`, label: `Option ${String(index)}` }))
    const pending = test.app.chooseMany('Pick some', items)
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('Pick some') })
    const rows = screen(test.app)
    expect(rows.join('\n')).toContain('(1/20)')
    // Ten options, the scroll line, and the key hint share the capped panel.
    expect(rows.filter(row => /Option \d/.test(row))).toHaveLength(10)
    test.terminal.feed(' ')
    test.terminal.feed('\r')
    await expect(pending).resolves.toMatchObject({ kind: 'answer', value: [{ value: 'opt-0' }] })
    await test.app.stop(0)
  })

  it('answers an empty multi-select batch without opening a prompt', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate' })
    await expect(test.app.chooseMany('Pick some', [])).resolves.toEqual({ kind: 'answer', value: [] })
    await test.app.stop(0)
  })

  it('settles an empty single-select batch without opening a prompt', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate' })
    await expect(test.app.choose('Pick one', [])).resolves.toEqual({ kind: 'cancel' })
    await test.app.stop(0)
  })

  it('settles a text prompt on Escape, Ctrl+C, and an aborted signal', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate' })
    const inputRow = (title: string): boolean => {
      const frame = screen(test.app)
      const heading = frame.findIndex(row => row.trim() === title)
      return heading >= 0 && frame[heading + 2]?.startsWith('> ') === true
    }
    const skipping = test.app.ask('Type first')
    await vi.waitFor(() => { expect(inputRow('Type first')).toBe(true) })
    test.terminal.feed('\x1b')
    await expect(skipping).resolves.toEqual({ kind: 'skip' })

    const cancelling = test.app.ask('Type second')
    await vi.waitFor(() => { expect(inputRow('Type second')).toBe(true) })
    test.terminal.feed('\x03')
    await expect(cancelling).resolves.toEqual({ kind: 'cancel' })

    const controller = new AbortController()
    const aborted = test.app.ask('Type third', controller.signal)
    await vi.waitFor(() => { expect(inputRow('Type third')).toBe(true) })
    controller.abort()
    await expect(aborted).resolves.toEqual({ kind: 'cancel' })
    await test.app.stop(0)
  })

  it('cancels a multi-select prompt when its signal aborts', async () => {
    const test = await bench({ afterPrompt: () => {} }, { screen: 'alternate' })
    const controller = new AbortController()
    const pending = test.app.chooseMany('Pick some', [{ value: 'a', label: 'Alpha' }], controller.signal)
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('Pick some') })
    controller.abort()
    await expect(pending).resolves.toEqual({ kind: 'cancel' })
    await test.app.stop(0)
  })
})

describe('TuiApp timed questions', () => {
  /**
   * Append the events that leave one timed `ask_user_question` call continued.
   * @param agent - the session's Agent.
   * @param callId - the call the pending result names.
   */
  function appendContinuedQuestion(agent: Agent, callId: ToolCallId): void {
    agent.session.append('request/header', {
      header: {
        config: { provider: 'test-provider', model: 'test-model' },
        tools: [{
          name: 'ask_user_question',
          description: 'Ask the user.',
          parameters: {
            type: 'object',
            properties: { questions: { type: 'array' }, timeout: { type: 'integer' } },
          },
        }],
      },
      reason: 'initial',
    })
    agent.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId,
      name: 'ask_user_question',
      arguments: JSON.stringify({ questions: [{ id: 'pick', question: 'Pick one', options: [{ label: 'Alpha' }] }] }),
    })
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: JSON.stringify({ pending: true, callId, message: 'pending' }) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
  }

  it('answers a timed question inside its window', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    const pending = test.ctx.userQuestions.askTimed({
      questions: [{ id: 'pick', question: 'Pick one', options: [{ label: 'Alpha' }, { label: 'Beta' }] }],
      agent,
    }, ToolCallId('call-timed-answer'), 5000)
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('Pick one'))).toBe(true)
    })
    // The app owns the claimed window, so the heading counts the seconds left.
    expect(screen(test.app).some(row => row.includes('left'))).toBe(true)

    test.terminal.feed('\r')
    await expect(pending).resolves.toMatchObject({ answers: [{ id: 'pick', selected: ['Alpha'] }] })
    await test.app.stop(0)
  })

  it('settles an unanswered timed question as pending', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    const pending = test.ctx.userQuestions.askTimed({
      questions: [{ id: 'pick', question: 'Pick one', options: [{ label: 'Alpha' }] }],
      agent,
    }, ToolCallId('call-timed-pending'), 40)
    await expect(pending).resolves.toMatchObject({ pending: true, callId: 'call-timed-pending' })
    await test.app.stop(0)
  })

  it('settles a skipped timed question with an empty selection', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    const pending = test.ctx.userQuestions.askTimed({
      questions: [{ id: 'pick', question: 'Pick one', options: [{ label: 'Alpha' }] }],
      agent,
    }, ToolCallId('call-timed-skip'), 5000)
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ Alpha'))).toBe(true)
    })
    test.terminal.feed('\x1b')
    await expect(pending).resolves.toMatchObject({ answers: [{ id: 'pick', selected: [] }] })
    await test.app.stop(0)
  })

  it('settles a cancelled timed question as pending', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    const pending = test.ctx.userQuestions.askTimed({
      questions: [{ id: 'pick', question: 'Pick one', options: [{ label: 'Alpha' }] }],
      agent,
    }, ToolCallId('call-timed-dismiss'), 5000)
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ Alpha'))).toBe(true)
    })
    test.terminal.feed('\x03')
    await expect(pending).resolves.toMatchObject({ pending: true })
    await test.app.stop(0)
  })

  it('cancels an open timed question when its turn aborts', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    const turn = new AbortController()
    const pending = test.ctx.userQuestions.askTimed({
      questions: [{ id: 'pick', question: 'Pick one', options: [{ label: 'Alpha' }] }],
      agent,
      signal: turn.signal,
    }, ToolCallId('call-timed-cancel'), 5000)
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ Alpha'))).toBe(true)
    })
    turn.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await test.app.stop(0)
  })

  it('answers a continued question through /questions', async () => {
    const test = await bench({ afterPrompt: () => {} }, { questions: true, screen: 'alternate' })
    const agent = owned(test)
    appendContinuedQuestion(agent, ToolCallId('call-late-1'))
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('question waiting'))).toBe(true)
    })

    test.terminal.feed('/questions')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('Answer which question?'))).toBe(true)
    })
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('→ Alpha'))).toBe(true)
    })
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(test.steered).toHaveLength(1)
    })
    expect(test.steered[0]?.source).toMatchObject({ kind: 'user-question-reply', callId: 'call-late-1' })
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

  it('reports the clipboard wait in the footer until the image arrives', async () => {
    const test = await bench(
      { afterPrompt: () => {} },
      { screen: 'alternate', attachments: true, modalities: ['text', 'image'] },
    )
    const pending = Promise.withResolvers<ClipboardImage | undefined>()
    internals.readClipboardImage = () => pending.promise
    test.terminal.feed('\x16')
    await vi.waitFor(() => {
      expect(screen(test.app).some(row => row.includes('pasting image…'))).toBe(true)
    })
    pending.resolve(clipboardImage())
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('[Image #1]') })
    expect(screen(test.app).some(row => row.includes('pasting image…'))).toBe(false)
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

describe('wheelScroll', () => {
  it('decodes an SGR wheel notch as one line, signed by direction', () => {
    expect(wheelScroll('\x1b[<64;10;5M')).toBe(-1)
    expect(wheelScroll('\x1b[<65;10;5M')).toBe(1)
  })

  it('decodes the legacy wheel encoding', () => {
    expect(wheelScroll(`\x1b[M${String.fromCharCode(64 + 32)}!!`)).toBe(-1)
  })

  it('multiplies an Alt-modified notch', () => {
    expect(wheelScroll('\x1b[<72;10;5M')).toBe(-5)
    expect(wheelScroll('\x1b[<73;10;5M')).toBe(5)
  })

  it('ignores input that is not a vertical wheel event', () => {
    expect(wheelScroll('\x1b[<0;10;5M')).toBeUndefined()
    expect(wheelScroll('\x1b[<66;10;5M')).toBeUndefined()
    expect(wheelScroll(`\x1b[M${String.fromCharCode(32)}!!`)).toBeUndefined()
    expect(wheelScroll('x')).toBeUndefined()
  })
})

/** A bash executor advertising confinement, so the app resolves a policy for each run. */
class ReadOnlyBashExecutor extends LocalBashExecutor {
  override get sandboxMode() {
    return 'read-only' as const
  }
}

describe('local shell commands', () => {
  /** A two-by-two PNG the mounted attachment store decodes. */
  function clipboardImage(): ClipboardImage {
    return { data: Buffer.from(PNG_BASE64, 'base64'), mediaType: 'image/png' }
  }

  /** Substitute the image the app reads from the clipboard. */
  function pasteClipboard(image: ClipboardImage | undefined): void {
    internals.readClipboardImage = () => Promise.resolve(image)
  }

  it('runs a ! command locally without reaching the model', async () => {
    const test = await bench({ afterPrompt: () => {} }, { shell: true })
    expect(plain(test.terminal.output)).toContain('! shell')
    test.terminal.feed('!echo local-output')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('[exit code: 0]')
    })
    const frame = plain(test.terminal.output)
    expect(frame).toContain('! echo local-output')
    expect(frame).toContain('> local-output')
    expect(frame).toContain('local')
    expect(test.submitted).toHaveLength(0)
    expect(test.steered).toHaveLength(0)
    await test.app.stop(0)
  })

  it('runs a confined ! command under the mounted sandbox policy', async () => {
    const test = await bench({ afterPrompt: () => {} }, { shell: 'read-only' })
    test.terminal.feed('!echo sandboxed')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('[exit code: 0]') })
    const frame = plain(test.terminal.output)
    expect(frame).toContain('local · read-only')
    expect(frame).toContain('> sandboxed')
    await test.app.stop(0)
  })

  it('reaches the model when the leading ! is escaped', async () => {
    const test = await bench({ afterPrompt: () => {} }, { shell: true })
    test.terminal.feed('\\!ls')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(test.submitted).toHaveLength(1) })
    expect(test.submitted[0]?.content).toEqual([{ type: 'text', text: '!ls' }])
    expect(plain(test.terminal.output)).not.toContain('[exit code:')
    await test.app.stop(0)
  })

  it('refuses an empty ! and keeps the draft', async () => {
    const test = await bench({ afterPrompt: () => {} }, { shell: true })
    test.terminal.feed('!')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('write a command after !')
    })
    expect(test.submitted).toHaveLength(0)
    const rendered = plain(test.terminal.output)
    expect(rendered.lastIndexOf('!')).toBeGreaterThan(rendered.lastIndexOf('write a command after !'))
    await test.app.stop(0)
  })

  it('refuses a ! line carrying an image and keeps the draft', async () => {
    const test = await bench({ afterPrompt: () => {} }, { shell: true, attachments: true, modalities: ['text', 'image'] })
    pasteClipboard(clipboardImage())
    test.terminal.feed('\x16')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('[Image #1]') })
    test.terminal.feed('!echo hi')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('a shell command cannot carry an image')
    })
    expect(test.submitted).toHaveLength(0)
    // The held image and the refused text stay in the composer.
    const rendered = plain(test.terminal.output)
    expect(rendered.lastIndexOf('[Image #1]')).toBeGreaterThan(rendered.lastIndexOf('a shell command cannot carry an image'))
    await test.app.stop(0)
  })

  it('sends an escaped ! line with its image to the model', async () => {
    const test = await bench({ afterPrompt: () => {} }, { shell: true, attachments: true, modalities: ['text', 'image'] })
    pasteClipboard(clipboardImage())
    test.terminal.feed('\x16')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('[Image #1]') })
    test.terminal.feed('\\!what is this')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(test.submitted).toHaveLength(1) })
    expect(test.submitted[0]?.content).toEqual([
      { type: 'text', text: '!what is this' },
      expect.objectContaining({ type: 'image' }),
    ])
    await test.app.stop(0)
  })

  it('refuses ! while a turn runs and keeps the draft', async () => {
    const test = await bench({ afterPrompt: () => {} }, { shell: true })
    test.setRunning(true)
    test.terminal.feed('!echo hi')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('a turn is running')
    })
    expect(test.submitted).toHaveLength(0)
    const rendered = plain(test.terminal.output)
    expect(rendered.lastIndexOf('!echo hi')).toBeGreaterThan(rendered.lastIndexOf('a turn is running'))
    await test.app.stop(0)
  })

  it('refuses ! while a compaction runs', async () => {
    const test = await bench({ afterPrompt: () => {} }, { shell: true })
    Reflect.set(test.app, 'compacting', true)
    test.terminal.feed('!ls')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('a compaction is running')
    })
    expect(test.submitted).toHaveLength(0)
    await test.app.stop(0)
  })

  it('refuses a prompt while a shell runs, then cancels the shell with Ctrl+C', async () => {
    const test = await bench({ afterPrompt: () => {} }, { shell: true })
    test.terminal.feed('!sleep 30')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('● shell') })
    expect(plain(test.terminal.output)).toContain('Ctrl+C stop shell')

    test.terminal.feed('hello there')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('a shell command is still running')
    })
    expect(test.submitted).toHaveLength(0)
    expect(test.steered).toHaveLength(0)
    const rendered = plain(test.terminal.output)
    expect(rendered.lastIndexOf('hello there')).toBeGreaterThan(rendered.lastIndexOf('a shell command is still running'))

    test.terminal.feed('\x03')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('[cancelled]') })
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('○ idle') })
    expect(test.exits).toEqual([])
    await test.app.stop(0)
  })

  it('refuses a second ! while a shell runs', async () => {
    const test = await bench({ afterPrompt: () => {} }, { shell: true })
    test.terminal.feed('!sleep 30')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('● shell') })
    test.terminal.feed('!ls')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('a shell command is still running')
    })
    const rendered = plain(test.terminal.output)
    expect(rendered.lastIndexOf('!ls')).toBeGreaterThan(rendered.lastIndexOf('a shell command is still running'))
    test.terminal.feed('\x03')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('[cancelled]') })
    await test.app.stop(0)
  })

  it('keeps commands available while a shell runs', async () => {
    const test = await bench({ afterPrompt: () => {} }, { shell: true })
    test.terminal.feed('!sleep 30')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('● shell') })
    test.terminal.feed('/help')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('List available commands')
    })
    test.terminal.feed('\x03')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('[cancelled]') })
    await test.app.stop(0)
  })

  it('drops a running shell when the session is replaced', async () => {
    const test = await bench({ afterPrompt: () => {} }, { shell: true })
    test.terminal.feed('!sleep 30')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('● shell') })
    test.terminal.feed('/new')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('started a new session')
    })
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('○ idle') })
    const rendered = plain(test.terminal.output)
    const afterNew = rendered.slice(rendered.lastIndexOf('started a new session'))
    expect(afterNew).not.toContain('● shell')
    await test.app.stop(0)
  })

  it('stops a running shell when the application exits', async () => {
    const test = await bench({ afterPrompt: () => {} }, { shell: true })
    test.terminal.feed('!sleep 30')
    test.terminal.feed('\r')
    await vi.waitFor(() => { expect(plain(test.terminal.output)).toContain('● shell') })
    await test.app.stop(0)
    expect(test.exits).toEqual([0])
  })

  it('reports a deployment without a shell executor', async () => {
    const test = await bench({ afterPrompt: () => {} })
    test.terminal.feed('!ls')
    test.terminal.feed('\r')
    await vi.waitFor(() => {
      expect(plain(test.terminal.output)).toContain('this deployment mounts no shell executor')
    })
    expect(test.submitted).toHaveLength(0)
    const rendered = plain(test.terminal.output)
    expect(rendered.lastIndexOf('!ls')).toBeGreaterThan(rendered.lastIndexOf('this deployment mounts no shell executor'))
    await test.app.stop(0)
  })
})
