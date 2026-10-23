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
import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
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
  private readonly selection: ModelSelectionRef
  /** Child session ids whose current local activation has not settled yet. */
  private readonly runningSubagents = new Set<SessionId>()
  /** Retires this session's subagent lifecycle subscriptions. */
  private readonly subagentSubscriptions: (() => void)[]

  private constructor(
    private readonly ctx: Context,
    private readonly handle: AgentHandle,
    selection: ModelSelectionRef,
  ) {
    this.selection = selection
    // The subagent lifecycle pair brackets a local activation, so the set holds
    // exactly the delegated work in flight; an idle resident child is absent
    // between its turns. External executions own no local child and are not
    // this surface's to stop.
    this.subagentSubscriptions = [
      ctx.on('subagent/start', ({ id, local }) => {
        if (local) this.runningSubagents.add(id)
      }),
      ctx.on('subagent/end', ({ id }) => { this.runningSubagents.delete(id) }),
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
    const selection: ModelSelectionRef = { current: initial, assembled: undefined }
    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>(`session-${randomUUID()}`),
      meta: { cwd: options.cwd },
      agentOptions: { provider: initial.provider, model: initial.model },
      setup: (agentCtx) => { installModelSelection(agentCtx, selection) },
    })
    return new TuiSession(ctx, handle, selection)
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
    const selection: ModelSelectionRef = { current: initial, assembled: undefined }
    const handle = await ctx.agents.resume({
      resumeSessionId: brandString<SessionId>(sessionId),
      agentOptions: { provider: initial.provider, model: initial.model },
      setup: (agentCtx) => { installModelSelection(agentCtx, selection) },
    })
    return new TuiSession(ctx, handle, selection)
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
    return this.selection.current ?? { provider: '', model: '' }
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
   * List the delegated children this session's catalogs record, in depth-first
   * catalog order. The read uses the live projection of every resident Session
   * and starts no turn, so it cannot steer or settle the Agent. A child whose
   * Session is no longer resident contributes its own catalog row, but its
   * descendants are not reached without a storage query.
   * @returns the rows in depth-first catalog order; empty when none were delegated.
   * @throws when the deployment mounts no session projection registry.
   */
  subagents(): TuiSubagent[] {
    const projections = this.ctx.get('sessionProjections')
    if (projections === undefined) {
      throw new Error('listing subagents requires the session projection registry')
    }
    const rows: TuiSubagent[] = []
    const visited = new Set<SessionId>([this.session.id])
    const visit = (session: Session, depth: number): void => {
      for (const child of projections.snapshot(session, ['subagentCatalog']).values.subagentCatalog ?? []) {
        if (visited.has(child.id)) continue
        visited.add(child.id)
        rows.push({
          id: child.id,
          mode: child.mode,
          ...child.label === undefined ? {} : { label: child.label },
          depth,
          running: this.runningSubagents.has(child.id),
        })
        const resident = this.ctx.sessions.get(child.id)
        if (resident !== undefined) visit(resident, depth + 1)
      }
    }
    visit(this.session, 1)
    return rows
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
    this.selection.current = { ...route }
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
