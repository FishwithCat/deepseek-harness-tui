/**
 * One interactive session: create or resume the single Agent this TUI drives,
 * submit prompts, switch the model route, and tear the Agent down. The registry
 * handle is the app's ownership capability, so no other consumer can dispose
 * this Agent.
 * @module @deepseek-ai/dsh-tui-app/session
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subagent/client'

/** One delegated child as the `/subagents` listing reports it. */
export interface TuiSubagent {
  /** Durable child session id, also the argument `dsh watch` takes. */
  readonly id: SessionId
  /** Catalog mode recorded by the parent when the child was created. */
  readonly mode: 'one-shot' | 'continuable' | 'external' | 'unknown'
  /** Durable creation label; absent for an unlabeled one-shot or external child. */
  readonly label?: string
  /** Edge distance from this session; direct children are 1. */
  readonly depth: number
  /** Whether the child's current local activation is still running. */
  readonly running: boolean
}

/** Invocation facts and route overrides for a session this app opens. */
export interface TuiSessionOptions {
  /** Working directory recorded on the session and used as the tool workspace root. */
  cwd: string
  /** Provider override from the command line, absent when the deployment default applies. */
  provider?: string | undefined
  /** Model override from the command line, absent when the deployment default applies. */
  model?: string | undefined
}

/**
 * Resolve the route this session starts on: the command-line override when it
 * names both halves, otherwise the deployment's default selection.
 * @param ctx - context carrying the default-model service.
 * @param options - the invocation's route overrides.
 * @returns the initial selection.
 */
function initialSelection(ctx: Context, options: TuiSessionOptions): ModelSelection {
  const fallback = ctx.agentDefaultModel.currentSelection()
  if (options.provider === undefined || options.model === undefined) return { ...fallback }
  return { provider: options.provider, model: options.model }
}

/** One live interactive session and the Agent behind it. */
export class TuiSession {
  /** Child session ids whose current local activation has not settled yet. */
  private readonly runningSubagents = new Set<SessionId>()
  /** Cached descendants, refreshed through the mounted subagent service. */
  private readonly subagentRows: TuiSubagent[] = []
  /** Failure from the last descendant read; `/subagents` reports it. */
  private subagentError: string | undefined
  /** In-flight descendant refresh shared by concurrent callers. */
  private subagentRefresh: Promise<void> | undefined
  /** A refresh was requested while one was already running. */
  private subagentRefreshQueued = false
  /** Retires this session's subagent lifecycle subscriptions. */
  private readonly subagentSubscriptions: (() => void)[]

  private constructor(
    private readonly ctx: Context,
    private readonly handle: AgentHandle,
  ) {
    // The subagent lifecycle pair brackets a local activation, so the set holds
    // exactly the delegated work in flight; an idle resident child is absent
    // between its turns. External executions own no local child and are not
    // this surface's to stop.
    this.subagentSubscriptions = [
      ctx.on('subagent/start', ({ id, local }) => {
        if (local) this.runningSubagents.add(id)
        void this.refreshSubagents()
      }),
      ctx.on('subagent/end', ({ id }) => {
        this.runningSubagents.delete(id)
        void this.refreshSubagents()
      }),
      ctx.on('session/event', (subject, event) => {
        if (subject === this.session && event.type === 'subagent/catalog') void this.refreshSubagents()
      }),
    ]
  }

  /**
   * Create a fresh Agent and its session.
   * @param ctx - context carrying the agent registry and default-model service.
   * @param options - invocation facts and route overrides.
   * @returns the live session.
   */
  static async create(ctx: Context, options: TuiSessionOptions): Promise<TuiSession> {
    const initial = initialSelection(ctx, options)
    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>(`session-${randomUUID()}`),
      meta: { cwd: options.cwd },
      agentOptions: { provider: initial.provider, model: initial.model },
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    })
    return new TuiSession(ctx, handle)
  }

  /**
   * Resume a stored session under a live Agent.
   * @param ctx - context carrying the agent registry, session store, and persistence.
   * @param sessionId - the stored session to resume.
   * @param options - invocation facts and route overrides.
   * @returns the live session.
   */
  static async resume(ctx: Context, sessionId: string, options: TuiSessionOptions): Promise<TuiSession> {
    const initial = initialSelection(ctx, options)
    const handle = await ctx.agents.resume({
      resumeSessionId: brandString<SessionId>(sessionId),
      agentOptions: { provider: initial.provider, model: initial.model },
      setup: (agentCtx, agent) => {
        // An explicit command-line route replaces the recorded selection; an
        // ordinary resume keeps the Session's own choice.
        if (options.provider !== undefined && options.model !== undefined) agent.model.select(initial)
        installModelSelection(agentCtx)
      },
    })
    return new TuiSession(ctx, handle)
  }

  /** The Agent this session owns. */
  get agent(): Agent {
    return this.handle.agent
  }

  /** The Agent's live session log. */
  get session(): Session {
    return this.handle.agent.session
  }

  /** The route in force for the next step. */
  get route(): ModelSelection {
    return this.agent.model.current() ?? { provider: '', model: '' }
  }

  /**
   * The stored events that seeded this session at resume, oldest first. The
   * read stops at the Session's first live sequence, so events appended after
   * resume stay with the live `session/event` stream instead of being folded
   * twice.
   * @returns the seed events in sequence order; empty when the deployment mounts no persistence backend.
   * @throws when the backend refuses to open or read the stored session.
   */
  async history(): Promise<readonly SessionEvent[]> {
    const persistence = this.ctx.get('sessionPersistence')
    /* v8 ignore next -- a seeded Session exists only on the resume path, which requires a persistence backend */
    if (persistence === undefined) return []
    const handle = await persistence.open(this.session.id, 'read')
    try {
      return (await handle.read(0, this.session.firstLiveSeq)).events
    } finally {
      await handle.close()
    }
  }

  /** Whether the Agent currently has work in flight. */
  get running(): boolean {
    return this.agent.status === 'running'
  }

  /** Whether the Agent or any live subagent descendant has work in flight. */
  get busy(): boolean {
    return this.running || this.hasRunningSubagents()
  }

  /**
   * Whether any local subagent activation of this session is still running.
   * @returns true while at least one `subagent/start` lacks its `subagent/end`.
   */
  hasRunningSubagents(): boolean {
    return this.runningSubagents.size > 0
  }

  /**
   * The delegated children last read through the subagent service, in catalog
   * pre-order. The panel and the footer read this cache; {@link refreshSubagents}
   * updates it without blocking a render.
   * @returns the cached rows; empty until the first refresh settles.
   */
  subagents(): readonly TuiSubagent[] {
    return this.subagentRows
  }

  /**
   * The last descendant read's failure, for the panel to report instead of an
   * empty list.
   * @returns the failure message, or undefined after a successful read.
   */
  subagentsFailure(): string | undefined {
    return this.subagentError
  }

  /**
   * Read this session's delegated descendants through `ctx.subagents`, which
   * owns catalog observation, cold-Session reads, and branch diagnostics.
   * Concurrent callers share one refresh; a request that arrives mid-read runs
   * again after it so the cache never settles on a stale catalog.
   * @returns after the cache reflects the latest completed read.
   */
  refreshSubagents(): Promise<void> {
    if (this.subagentRefresh !== undefined) {
      this.subagentRefreshQueued = true
      return this.subagentRefresh
    }
    this.subagentRefresh = (async () => {
      do {
        try {
          const rows = await this.readSubagents()
          this.subagentRows.splice(0, this.subagentRows.length, ...rows)
          this.subagentError = undefined
        } catch (error: unknown) {
          this.subagentRows.length = 0
          this.subagentError = error instanceof Error ? error.message : String(error)
        }
      } while (this.consumeRefreshRequest())
    })().finally(() => { this.subagentRefresh = undefined })
    return this.subagentRefresh
  }

  /**
   * Take one pending refresh request.
   * @returns whether another refresh was requested while the last read ran.
   */
  private consumeRefreshRequest(): boolean {
    const queued = this.subagentRefreshQueued
    this.subagentRefreshQueued = false
    return queued
  }

  /**
   * Read the service's descendant rows and project them for the terminal.
   * @returns the rows in catalog pre-order.
   * @throws when the composition mounts no subagent service.
   */
  private async readSubagents(): Promise<TuiSubagent[]> {
    const subagents = this.ctx.get('subagents')
    if (subagents === undefined) throw new Error('listing subagents requires the subagent service')
    const entries = await subagents.listDescendants(this.session.id)
    return entries.map((entry): TuiSubagent => {
      if (entry.kind === 'diagnostic') {
        return {
          id: entry.id,
          mode: 'unknown',
          label: `${entry.reason} subagent`,
          depth: entry.depth,
          running: false,
        }
      }
      return {
        id: entry.id,
        mode: entry.mode,
        ...entry.label === undefined ? {} : { label: entry.label },
        depth: entry.depth,
        running: this.runningSubagents.has(entry.id) || this.ctx.get('agents')?.get(entry.id)?.status === 'running',
      }
    })
  }

  /**
   * Queue one human prompt as its own turn.
   * @param content - the prompt's content blocks in message order.
   */
  submit(content: readonly ContentBlock[]): void {
    this.agent.followup(createUserMessage({
      content: [...content],
      source: { kind: 'user' },
    }))
  }

  /**
   * Submit steering that the running turn consumes at its next step, or that
   * starts a turn when the Agent is idle.
   * @param content - the steering content blocks in message order.
   */
  steer(content: readonly ContentBlock[]): void {
    this.agent.steer(createUserMessage({
      content: [...content],
      source: { kind: 'user' },
    }))
  }

  /**
   * Abort the active turn, drop pending input, and interrupt every running
   * subagent descendant under this Agent's ancestor authority; a user interrupt
   * owns the cause. A composition without the subagent service stops only this
   * Agent, and one child whose interrupt is rejected is logged without keeping
   * its siblings running.
   */
  cancel(): void {
    this.agent.cancel({ kind: 'user' })
    const subagents = this.ctx.get('subagents')
    if (subagents === undefined) return
    for (const childId of [...this.runningSubagents]) {
      try {
        subagents.interrupt(childId, { kind: 'ancestor', agent: this.agent })
      } catch (error: unknown) {
        this.ctx.logger.warn(`subagent: interrupting "${childId}" for its cancelled root failed: ${String(error)}`)
      }
    }
  }

  /**
   * Switch the route used by later steps.
   * @param route - the new provider and model.
   */
  selectModel(route: ModelSelection): void {
    this.agent.model.select(route)
  }

  /** Drain this session's durable events to storage. */
  async flush(): Promise<void> {
    await this.ctx.sessions.flush(this.session)
  }

  /** Stop the Agent, unregister it, and unwind its scoped world. */
  async dispose(): Promise<void> {
    for (const dispose of this.subagentSubscriptions) dispose()
    await this.handle.dispose()
  }
}
