/**
 * Terminal answerers for the two interaction seams the Agent pauses on: tool
 * approvals and structured user questions. Both delegate anything that does not
 * belong to the app's own Agent, so a composition that also mounts subagents or
 * another surface keeps its own answerers authoritative. A timed question is
 * claimed through the user-questions service so this surface owns the
 * countdown; a window that closes without an answer settles the call as
 * pending, leaving it answerable as a late reply.
 * @module @deepseek-ai/dsh-tui-app/interactions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SelectItem } from '@earendil-works/pi-tui'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-questions'

/** A heading that is a fixed string, or a provider the surface re-evaluates as it repaints. */
export type InteractionTitle = string | (() => string)

/** The terminal surfaces the answerers drive. */
export interface InteractionHost {
  /**
   * Ask the user to choose one item.
   * @param title - the question shown above the list; a provider is re-evaluated on every repaint.
   * @param items - the selectable items.
   * @param signal - cancellation lifetime; aborting dismisses the prompt.
   * @param detail - markdown shown above the list, scrollable with Up/Down, PageUp/PageDown, and the wheel.
   * @returns the chosen item, or undefined when the user cancelled.
   */
  choose(title: InteractionTitle, items: readonly SelectItem[], signal?: AbortSignal, detail?: string): Promise<SelectItem | undefined>
  /**
   * Ask the user to check any number of items.
   * @param title - the question shown above the list; a provider is re-evaluated on every repaint.
   * @param items - the selectable items.
   * @param signal - cancellation lifetime; aborting dismisses the prompt.
   * @param detail - markdown shown above the list, scrollable with Up/Down, PageUp/PageDown, and the wheel.
   * @returns the checked items in list order, or undefined when the user cancelled.
   */
  chooseMany(
    title: InteractionTitle,
    items: readonly SelectItem[],
    signal?: AbortSignal,
    detail?: string,
  ): Promise<SelectItem[] | undefined>
  /**
   * Ask the user for one line of text.
   * @param title - the question shown above the input; a provider is re-evaluated on every repaint.
   * @param signal - cancellation lifetime; aborting dismisses the prompt.
   * @param detail - markdown shown above the input, scrollable with Up/Down, PageUp/PageDown, and the wheel.
   * @returns the entered text, or undefined when the user cancelled.
   */
  ask(title: InteractionTitle, signal?: AbortSignal, detail?: string): Promise<string | undefined>
}

/** Option value that allows one approved action. */
const ALLOW = 'allow-once'
/** Option value that refuses one action. */
const REJECT = 'reject'

/**
 * Longest delay one platform timer accepts. A longer remaining window re-arms
 * instead of overflowing to an immediate fire.
 */
const MAX_TIMER_MS = 2_147_483_647

/** One claimed foreground wait: the remaining window and the claim's release. */
interface TimedClaim {
  /** Milliseconds left in the answer window the Host computed when the claim opened. */
  readonly remainingMs: number
  /** Release the claim; the Host resumes counting the original deadline. */
  release(): void
}

/**
 * Format the window left before a timed prompt closes.
 * @param deadline - absolute epoch milliseconds the window ends at.
 * @returns seconds left, rounded up, as a short suffix.
 */
function remainingLabel(deadline: number): string {
  return `${String(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)))}s left`
}

/**
 * Call `expire` when an absolute deadline passes, re-arming across the platform
 * timer's longest delay.
 * @param deadline - absolute epoch milliseconds to expire at.
 * @param expire - called once when the deadline is reached.
 * @returns a disposer that cancels the pending timer.
 */
function armExpiry(deadline: number, expire: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>
  const tick = (): void => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      expire()
      return
    }
    timer = setTimeout(tick, Math.min(remaining, MAX_TIMER_MS))
  }
  tick()
  return () => { clearTimeout(timer) }
}

/**
 * Hold a timed question's foreground wait for this surface.
 *
 * The service counts the deadline only while no answer UI holds it, so claiming
 * is what lets the terminal draw the countdown and decide the settlement.
 * @param ctx - context carrying the user-questions service.
 * @param owned - the Agent whose wait is claimed.
 * @param callId - foreground tool call the wait belongs to.
 * @returns the claim, or undefined when the service is absent or the wait already settled.
 */
async function claimTimedWait(ctx: Context, owned: Agent, callId: ToolCallId): Promise<TimedClaim | undefined> {
  const questions = ctx.get('userQuestions')
  if (questions === undefined) return undefined
  const controller = new AbortController()
  const stream = questions.attachWait(owned, callId, controller.signal)[Symbol.asyncIterator]()
  const first = await stream.next()
  if (first.done === true) {
    controller.abort()
    return undefined
  }
  return {
    remainingMs: first.value.remainingMs,
    release: () => {
      controller.abort()
      void stream.return?.()
    },
  }
}

/**
 * Answer approvals for one owned Agent, one request at a time.
 * @param ctx - the plugin context whose waterfall carries approval requests.
 * @param host - the terminal prompt surface.
 * @param owned - the Agent this app answers for.
 * @returns a disposer removing the listener.
 */
export function installApprovalAnswerer(ctx: Context, host: InteractionHost, owned: Agent): () => void {
  return ctx.on('approval/request', (request, next) => {
    if (request.agent !== owned) return next()
    const items: SelectItem[] = [
      { value: ALLOW, label: 'Allow once', description: request.reason ?? request.toolName },
      { value: REJECT, label: 'Reject', description: 'Deny this call' },
    ]
    return host.choose(`Allow ${request.toolName}?`, items, request.signal).then((choice): ApprovalOutcome => {
      if (choice === undefined) return 'cancelled'
      return choice.value === ALLOW ? 'allowed-once' : 'rejected'
    })
  })
}

/**
 * Answer one structured question.
 *
 * A multi-select question opens a checkable list and answers with every checked
 * label. A plan review is special: its non-approve choice is not an answer to
 * send back. The terminal has no separate "talk it over" action, so choosing
 * Keep planning means the user kept planning to speak instead — leaving the
 * question unanswered hands the turn back so the agent stays in plan mode and
 * waits for their adjustment rather than revising immediately.
 * @param host - the terminal prompt surface.
 * @param question - the question to present.
 * @param signal - cancellation lifetime of the whole request.
 * @param deadline - absolute epoch milliseconds a timed window ends at; the heading counts down to it.
 * @returns the answer item, or undefined when the user dismissed the prompt or
 * chose to keep planning instead of answering.
 */
export async function answerQuestion(
  host: InteractionHost,
  question: AskUserQuestionItem,
  signal: AbortSignal | undefined,
  deadline?: number,
): Promise<AskUserQuestionAnswerItem | undefined> {
  const heading = question.header === undefined ? question.question : `${question.header}: ${question.question}`
  const options = question.options ?? []
  if (options.length === 0) {
    const title = deadline === undefined ? heading : (): string => `${heading}  ·  ${remainingLabel(deadline)}`
    const text = await host.ask(title, signal, question.detail)
    if (text === undefined) return undefined
    return { id: question.id, selected: [], custom: text }
  }
  const items: SelectItem[] = options.map(option => ({
    value: option.label,
    label: option.label,
    ...(option.description === undefined ? {} : { description: option.description }),
  }))
  const title = deadline === undefined ? heading : (): string => `${heading}  ·  ${remainingLabel(deadline)}`
  if (question.multiSelect === true) {
    const checked = await host.chooseMany(title, items, signal, question.detail)
    if (checked === undefined) return undefined
    return { id: question.id, selected: checked.map(item => item.value) }
  }
  const chosen = await host.choose(title, items, signal, question.detail)
  if (chosen === undefined) return undefined
  if (question.intent?.kind === 'plan-review' && chosen.value !== question.intent.approve) return undefined
  return { id: question.id, selected: [chosen.value] }
}

/**
 * Answer a timed question batch.
 *
 * This surface owns the countdown once it claims the wait, so the window
 * closing — by the clock or by the user's dismissal — settles the call as
 * pending and leaves it answerable as a late reply. The host's own signal
 * closes the prompt when the calling Turn is cancelled or the wait is disposed.
 * @param ctx - context carrying the user-questions service.
 * @param host - the terminal prompt surface.
 * @param owned - the Agent the questions belong to.
 * @param request - the pending request, including the host wait's cancellation signal.
 * @param callId - foreground tool call the wait is keyed by.
 * @returns the submitted answer batch.
 * @throws {UserQuestionError} `ASK_TIMED_OUT` when no batch arrives inside the window.
 */
async function answerTimedRequest(
  ctx: Context,
  host: InteractionHost,
  owned: Agent,
  request: { readonly questions: readonly AskUserQuestionItem[]; readonly signal?: AbortSignal },
  callId: ToolCallId,
): Promise<AskUserQuestionAnswer> {
  const claim = await claimTimedWait(ctx, owned, callId)
  if (claim === undefined) {
    throw new UserQuestionError('the timed question is no longer waiting', 'ASK_TIMED_OUT')
  }
  const deadline = Date.now() + claim.remainingMs
  const window = new AbortController()
  const cancelPrompt = (): void => { window.abort() }
  request.signal?.addEventListener('abort', cancelPrompt, { once: true })
  if (request.signal?.aborted === true) cancelPrompt()
  const cancelExpiry = armExpiry(deadline, () => { window.abort() })
  try {
    const answers: AskUserQuestionAnswerItem[] = []
    for (const question of request.questions) {
      const answer = await answerQuestion(host, question, window.signal, deadline)
      if (answer === undefined) {
        // The host aborts its own wait only for a cancelled Turn or disposal;
        // the claimed deadline is this surface's timer, not the host's.
        if (request.signal?.aborted === true) {
          throw new UserQuestionError('the timed question was cancelled', 'ASK_ABORTED')
        }
        throw new UserQuestionError('the user did not answer before the wait ended', 'ASK_TIMED_OUT')
      }
      answers.push(answer)
    }
    return { answers }
  } finally {
    request.signal?.removeEventListener('abort', cancelPrompt)
    cancelExpiry()
    claim.release()
  }
}

/**
 * Answer structured user questions for one owned Agent. A dismissed prompt
 * fails the asking Tool with the seam's aborted code instead of leaving the
 * request unanswered; a plan review the user keeps planning fails it with the
 * cancelled code, the one plan mode reads as "the user took the turn back".
 *
 * A timed request is claimed and counted down by this surface: an unanswered or
 * dismissed window resolves the Tool's pending result rather than failing it,
 * so the question stays answerable through `/questions`.
 * @param ctx - the plugin context whose waterfall carries question requests.
 * @param host - the terminal prompt surface.
 * @param owned - the Agent this app answers for.
 * @returns a disposer removing the listener.
 */
export function installQuestionAnswerer(ctx: Context, host: InteractionHost, owned: Agent): () => void {
  return ctx.on('user-questions/request', async (request, next) => {
    if (request.agent !== undefined && request.agent !== owned) return next()
    const wait = request.wait
    if (wait?.timed === true) return await answerTimedRequest(ctx, host, owned, request, wait.callId)
    const answers: AskUserQuestionAnswerItem[] = []
    for (const question of request.questions) {
      const answer = await answerQuestion(host, question, request.signal)
      if (answer === undefined) {
        const planReview = question.intent?.kind === 'plan-review'
        throw new UserQuestionError(
          planReview
            ? 'the user kept planning to speak instead'
            : 'the user dismissed the question prompt',
          planReview ? 'ASK_CANCELLED' : 'ASK_ABORTED',
        )
      }
      answers.push(answer)
    }
    return { answers }
  })
}
