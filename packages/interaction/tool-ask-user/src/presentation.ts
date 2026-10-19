/**
 * Host presentation for `ask_user_question`: the question batch and its answer
 * batch as readable lines, instead of the model-facing JSON arguments and
 * result. A host that renders tool presentation views shows the questions and
 * what the user chose; the model-facing result stays compact JSON.
 * @module @deepseek-ai/dsh-tool-ask-user/presentation
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'

/** One question the presenter reads from the tool's call arguments. */
export interface PresentedQuestion {
  /** Stable id linking the question to its answer. */
  readonly id: string
  /** The question text. */
  readonly question: string
  /** Optional short label above the question. */
  readonly header?: string | undefined
}

/** One recorded answer, as the answer batch carries it. */
interface PresentedAnswer {
  /** Question id the answer belongs to. */
  readonly id: string
  /** Chosen option labels. */
  readonly selected: readonly string[]
  /** Free-form answer that replaces or supplements the chosen labels. */
  readonly custom?: string | undefined
}

/** Marker that names a question the user moved past without answering. */
const SKIPPED = '  → (skipped)'

/**
 * One question's display label: its header when it has one, then its text.
 * @param question - the question to label.
 * @returns the label on one line.
 */
function questionLabel(question: PresentedQuestion): string {
  return question.header === undefined
    ? question.question
    : `${question.header} · ${question.question}`
}

/**
 * The questions as one text block, one question per line.
 * @param questions - the questions to list.
 * @returns the view content.
 */
function questionContent(questions: readonly PresentedQuestion[]): ContentBlock[] {
  return [{ type: 'text', text: questions.map(questionLabel).join('\n') }]
}

/**
 * Concatenate one tool result's text blocks.
 * @param blocks - the result content.
 * @returns the visible text.
 */
function resultText(blocks: readonly ContentBlock[]): string {
  let text = ''
  for (const block of blocks) {
    /* v8 ignore next -- the tool's render declares exactly one text block */
    if (block.type === 'text') text += block.text
  }
  return text
}

/**
 * Whether a decoded JSON value is a non-null, non-array object.
 * @param value - the decoded value.
 * @returns true when named fields can be read from it.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the answer entries out of a successful result's JSON object.
 *
 * The result is a durable payload, so every field is checked before the row can
 * present it as a choice the user made.
 * @param parsed - the decoded result object.
 * @returns the answer entries, or undefined when the payload is not one.
 */
function answerEntries(parsed: Record<string, unknown>): PresentedAnswer[] | undefined {
  if (!Array.isArray(parsed.answers)) return undefined
  const answers: PresentedAnswer[] = []
  for (const answer of parsed.answers) {
    if (!isRecord(answer) || typeof answer.id !== 'string' || !Array.isArray(answer.selected)) return undefined
    if (!answer.selected.every(label => typeof label === 'string')) return undefined
    if (answer.custom !== undefined && typeof answer.custom !== 'string') return undefined
    answers.push({
      id: answer.id,
      selected: answer.selected,
      ...answer.custom === undefined ? {} : { custom: answer.custom },
    })
  }
  return answers
}

/**
 * The presentation view for a pending `ask_user_question` call.
 *
 * A batch renders as its questions, one per line, no matter how many arrived;
 * the title stays the same so a reader recognizes the Tool across states.
 * @param questions - the questions the call asks.
 * @returns the generic call view.
 */
export function presentAskCall(questions: readonly PresentedQuestion[]): ToolCallView {
  return {
    card: 'generic',
    title: 'Ask user question',
    content: questionContent(questions),
  }
}

/**
 * The presentation view for a settled `ask_user_question` call.
 *
 * Each question is followed by the labels the user chose, or by a skip marker.
 * A timed call whose window closed without an answer shows that it is still
 * waiting; a failed call declares no view so the ordinary error row remains.
 * @param questions - the questions the call asked.
 * @param result - the settled result projection.
 * @returns the generic result view, or undefined when the result is an error or
 * carries no readable batch.
 */
export function presentAskResult(
  questions: readonly PresentedQuestion[],
  result: { readonly content: readonly ContentBlock[]; readonly isError: boolean },
): ToolResultView | undefined {
  if (result.isError) return undefined
  const text = resultText(result.content)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // The model-facing result is JSON by render contract; anything else has no presentation.
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  if (parsed.pending === true) {
    return {
      card: 'generic',
      title: 'Ask user question · waiting for an answer',
      content: questionContent(questions),
    }
  }
  const answers = answerEntries(parsed)
  if (answers === undefined) return undefined
  const byId = new Map(answers.map(answer => [answer.id, answer]))
  const lines: string[] = []
  let answered = 0
  for (const question of questions) {
    const answer = byId.get(question.id)
    if (answer === undefined) return undefined
    const chosen = [
      ...answer.selected,
      ...answer.custom === undefined || answer.custom === '' ? [] : [answer.custom],
    ]
    if (chosen.length > 0) answered += 1
    lines.push(questionLabel(question), chosen.length === 0 ? SKIPPED : `  → ${chosen.join(', ')}`)
  }
  return {
    card: 'generic',
    title: `Ask user question · ${String(answered)} of ${String(questions.length)} answered`,
    content: [{ type: 'text', text: lines.join('\n') }],
  }
}
