/**
 * Terminal answerers for the two interaction seams the Agent pauses on: tool
 * approvals and structured user questions. Both delegate anything that does not
 * belong to the app's own Agent, so a composition that also mounts subagents or
 * another surface keeps its own answerers authoritative.
 * @module @deepseek-ai/dsh-tui-app/interactions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SelectItem } from '@earendil-works/pi-tui'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-questions'

/** The terminal surfaces the answerers drive. */
export interface InteractionHost {
  /**
   * Ask the user to choose one item.
   * @param title - the question shown above the list.
   * @param items - the selectable items.
   * @param signal - cancellation lifetime; aborting dismisses the prompt.
   * @returns the chosen item, or undefined when the user cancelled.
   */
  choose(title: string, items: readonly SelectItem[], signal?: AbortSignal): Promise<SelectItem | undefined>
  /**
   * Ask the user for one line of text.
   * @param title - the question shown above the input.
   * @param signal - cancellation lifetime; aborting dismisses the prompt.
   * @returns the entered text, or undefined when the user cancelled.
   */
  ask(title: string, signal?: AbortSignal): Promise<string | undefined>
}

/** Option value that allows one approved action. */
const ALLOW = 'allow-once'
/** Option value that refuses one action. */
const REJECT = 'reject'

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
 * @param host - the terminal prompt surface.
 * @param question - the question to present.
 * @param signal - cancellation lifetime of the whole request.
 * @returns the answer item, or undefined when the user dismissed the prompt.
 */
async function answerQuestion(
  host: InteractionHost,
  question: AskUserQuestionItem,
  signal: AbortSignal | undefined,
): Promise<AskUserQuestionAnswerItem | undefined> {
  const heading = question.header === undefined ? question.question : `${question.header}: ${question.question}`
  const options = question.options ?? []
  if (options.length === 0) {
    const text = await host.ask(heading, signal)
    if (text === undefined) return undefined
    return { id: question.id, selected: [], custom: text }
  }
  const items: SelectItem[] = options.map(option => ({
    value: option.label,
    label: option.label,
    ...(option.description === undefined ? {} : { description: option.description }),
  }))
  const title = question.multiSelect === true ? `${heading} (one choice per prompt)` : heading
  const chosen = await host.choose(title, items, signal)
  if (chosen === undefined) return undefined
  return { id: question.id, selected: [chosen.value] }
}

/**
 * Answer structured user questions for one owned Agent. A dismissed prompt
 * fails the asking Tool with the seam's aborted code instead of leaving the
 * request unanswered.
 * @param ctx - the plugin context whose waterfall carries question requests.
 * @param host - the terminal prompt surface.
 * @param owned - the Agent this app answers for.
 * @returns a disposer removing the listener.
 */
export function installQuestionAnswerer(ctx: Context, host: InteractionHost, owned: Agent): () => void {
  return ctx.on('user-questions/request', async (request, next) => {
    if (request.agent !== undefined && request.agent !== owned) return next()
    const answers: AskUserQuestionAnswerItem[] = []
    for (const question of request.questions) {
      const answer = await answerQuestion(host, question, request.signal)
      if (answer === undefined) {
        throw new UserQuestionError('the user dismissed the question prompt', 'ASK_ABORTED')
      }
      answers.push(answer)
    }
    return { answers }
  })
}
