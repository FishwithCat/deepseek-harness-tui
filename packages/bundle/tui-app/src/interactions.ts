/**
 * Terminal answerers for the two interaction seams the Agent pauses on: tool
 * approvals and structured user questions. Both delegate anything that does not
 * belong to the app's own Agent, so a composition that also mounts subagents or
 * another surface keeps its own answerers authoritative. A timed question is
 * claimed through the user-questions service so this surface owns the
 * countdown; a window that closes without an answer settles the call as
 * pending, leaving it answerable as a late reply. A question's options end in a
 * free-text `Other…` row, Escape skips the question, and Ctrl+C cancels the
 * whole ask.
 * @module @deepseek-ai/dsh-tui-app/interactions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SelectItem } from '@earendil-works/pi-tui'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { PromptHeading, PromptTitle } from './views.ts'

/** A heading that is a fixed value, or a provider the surface re-evaluates as it repaints. */
export type InteractionTitle = PromptTitle

/**
 * How one modal prompt settled.
 *
 * `skip` is Escape's own outcome, distinct from `cancel` only because a question
 * batch advances past a skipped question while a cancelled one is abandoned;
 * every other caller treats the two alike.
 */
export type PromptOutcome<T> =
  | { readonly kind: 'answer'; readonly value: T }
  | { readonly kind: 'skip' }
  | { readonly kind: 'cancel' }

/** The terminal surfaces the answerers drive. */
export interface InteractionHost {
  /**
   * Ask the user to choose one item.
   * @param title - the question shown above the list; a provider is re-evaluated on every repaint.
   * @param items - the selectable items.
   * @param signal - cancellation lifetime; aborting cancels the prompt.
   * @param detail - markdown shown above the list, scrollable with Up/Down, PageUp/PageDown, and the wheel.
   * @returns how the prompt settled: the chosen item, Escape's skip, or Ctrl+C's cancel.
   */
  choose(title: InteractionTitle, items: readonly SelectItem[], signal?: AbortSignal, detail?: string): Promise<PromptOutcome<SelectItem>>
  /**
   * Ask the user to check any number of items.
   * @param title - the question shown above the list; a provider is re-evaluated on every repaint.
   * @param items - the selectable items.
   * @param signal - cancellation lifetime; aborting cancels the prompt.
   * @param detail - markdown shown above the list, scrollable with Up/Down, PageUp/PageDown, and the wheel.
   * @returns how the prompt settled: the checked items in list order, Escape's skip, or Ctrl+C's cancel.
   */
  chooseMany(
    title: InteractionTitle,
    items: readonly SelectItem[],
    signal?: AbortSignal,
    detail?: string,
  ): Promise<PromptOutcome<SelectItem[]>>
  /**
   * Ask the user for one line of text.
   * @param title - the question shown above the input; a provider is re-evaluated on every repaint.
   * @param signal - cancellation lifetime; aborting cancels the prompt.
   * @param detail - markdown shown above the input, scrollable with Up/Down, PageUp/PageDown, and the wheel.
   * @returns how the prompt settled: the entered text, Escape's skip, or Ctrl+C's cancel.
   */
  ask(title: InteractionTitle, signal?: AbortSignal, detail?: string): Promise<PromptOutcome<string>>
}

/** Option value the ask flow appends for its free-text row; it never reaches an answer. */
const OTHER_OPTION = '\u0000other'
/** Label of the free-text row {@link OTHER_OPTION} marks. */
const OTHER_LABEL = 'Other…'

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
    return host.choose(`Allow ${request.toolName}?`, items, request.signal).then((outcome): ApprovalOutcome => {
      if (outcome.kind !== 'answer') return 'cancelled'
      return outcome.value.value === ALLOW ? 'allowed-once' : 'rejected'
    })
  })
}

/** One question's place in the batch it arrived with. */
export interface QuestionPosition {
  /** Zero-based index of the question. */
  readonly index: number
  /** Number of questions the batch carries. */
  readonly total: number
}

/** How one question is presented: its cancellation lifetime, timed window, and batch place. */
export interface AnswerQuestionOptions {
  /** Cancellation lifetime of the whole request; aborting cancels the ask. */
  readonly signal?: AbortSignal | undefined
  /** Absolute epoch milliseconds a timed window ends at; the heading counts down to it. */
  readonly deadline?: number | undefined
  /** The question's place in a multi-question batch; a lone question shows none. */
  readonly position?: QuestionPosition | undefined
}

/**
 * Compose one question's heading.
 *
 * A timed window's heading is a provider so the panel re-reads the countdown on
 * every repaint, and the surface starts its repaint timer for it.
 * @param question - the question to present.
 * @param position - the question's place in its batch, when more than one was asked.
 * @param deadline - absolute epoch milliseconds a timed window ends at.
 * @returns the heading: a dim label, the wrapped question, and any countdown.
 */
function questionHeading(
  question: AskUserQuestionItem,
  position: QuestionPosition | undefined,
  deadline: number | undefined,
): InteractionTitle {
  const label: string[] = []
  if (position !== undefined && position.total > 1) label.push(`${String(position.index + 1)}/${String(position.total)}`)
  if (question.header !== undefined) label.push(question.header)
  const heading: PromptHeading = {
    ...label.length === 0 ? {} : { header: label.join(' · ') },
    question: question.question,
  }
  if (deadline === undefined) return heading
  return (): PromptHeading => ({ ...heading, trailing: remainingLabel(deadline) })
}

/**
 * Collect the free-form answer an `Other…` choice asks for.
 * @param host - the terminal prompt surface.
 * @param title - the heading repeated above the input.
 * @param question - the question the note answers.
 * @param options - cancellation lifetime and timed window of the request.
 * @param selected - options the user already checked, carried into the answer.
 * @param planReview - whether the note reviews a plan, whose empty answer hands
 * the turn back instead of answering.
 * @returns the answer item, or undefined when the user cancelled the prompt.
 */
async function answerOther(
  host: InteractionHost,
  title: InteractionTitle,
  question: AskUserQuestionItem,
  options: AnswerQuestionOptions,
  selected: readonly string[],
  planReview: boolean,
): Promise<AskUserQuestionAnswerItem | undefined> {
  const note = await host.ask(title, options.signal, question.detail)
  switch (note.kind) {
    case 'cancel':
      return undefined
    case 'skip':
      return planReview ? undefined : { id: question.id, selected: [...selected] }
    case 'answer':
      if (note.value !== '') return { id: question.id, selected: [...selected], custom: note.value }
      return planReview ? undefined : { id: question.id, selected: [...selected] }
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default:
      return assertNever(note, 'prompt outcome')
  }
}

/**
 * Answer one structured question.
 *
 * A question with options opens a picker whose last row is `Other…`: choosing it
 * collects a free-form answer, which replaces a single selection and
 * accompanies a multi-selection. Escape skips the question with an empty
 * selection so the batch advances; Ctrl+C cancels the whole request.
 *
 * A plan review is special: its non-approve choice is not an answer to send
 * back. The terminal has no separate "talk it over" action, so choosing Keep
 * planning means the user kept planning to speak instead — leaving the question
 * unanswered hands the turn back so the agent stays in plan mode and waits for
 * their adjustment rather than revising immediately. Every unanswered path
 * there hands the turn back the same way, while `Other…` carries the user's own
 * feedback to the waiting model.
 * @param host - the terminal prompt surface.
 * @param question - the question to present.
 * @param options - cancellation lifetime, timed window, and batch place.
 * @returns the answer item, or undefined when the user cancelled the prompt or
 * chose to keep planning instead of answering.
 */
export async function answerQuestion(
  host: InteractionHost,
  question: AskUserQuestionItem,
  options: AnswerQuestionOptions = {},
): Promise<AskUserQuestionAnswerItem | undefined> {
  const title = questionHeading(question, options.position, options.deadline)
  const declared = question.options ?? []
  const planReview = question.intent?.kind === 'plan-review'
  if (declared.length === 0) {
    return await answerOther(host, title, question, options, [], false)
  }
  const items: SelectItem[] = declared.map(option => ({
    value: option.label,
    label: option.label,
    ...(option.description === undefined ? {} : { description: option.description }),
  }))
  items.push({ value: OTHER_OPTION, label: OTHER_LABEL })
  if (question.multiSelect === true) {
    const checked = await host.chooseMany(title, items, options.signal, question.detail)
    switch (checked.kind) {
      case 'cancel':
        return undefined
      case 'skip':
        return { id: question.id, selected: [] }
      case 'answer': {
        const selected = checked.value.filter(item => item.value !== OTHER_OPTION).map(item => item.value)
        return checked.value.some(item => item.value === OTHER_OPTION)
          ? await answerOther(host, title, question, options, selected, false)
          : { id: question.id, selected }
      }
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(checked, 'prompt outcome')
    }
  }
  const chosen = await host.choose(title, items, options.signal, question.detail)
  switch (chosen.kind) {
    case 'cancel':
      return undefined
    case 'skip':
      return planReview ? undefined : { id: question.id, selected: [] }
    case 'answer':
      if (chosen.value.value === OTHER_OPTION) {
        return await answerOther(host, title, question, options, [], planReview)
      }
      if (planReview && chosen.value.value !== question.intent?.approve) return undefined
      return { id: question.id, selected: [chosen.value.value] }
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default:
      return assertNever(chosen, 'prompt outcome')
  }
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
    const total = request.questions.length
    for (const [index, question] of request.questions.entries()) {
      const answer = await answerQuestion(host, question, { signal: window.signal, deadline, position: { index, total } })
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
    const total = request.questions.length
    for (const [index, question] of request.questions.entries()) {
      const answer = await answerQuestion(host, question, { signal: request.signal, position: { index, total } })
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
