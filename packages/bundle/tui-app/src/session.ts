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
import type { Session, SessionId } from '@deepseek-ai/dsh-session'

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

  private constructor(
    private readonly ctx: Context,
    private readonly handle: AgentHandle,
    selection: ModelSelectionRef,
  ) {
    this.selection = selection
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

  /** Whether the Agent currently has work in flight. */
  get running(): boolean {
    return this.agent.status === 'running'
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

  /** Abort the active turn and drop pending input; a user interrupt owns the cause. */
  cancel(): void {
    this.agent.cancel({ kind: 'user' })
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
    await this.handle.dispose()
  }
}
