/**
 * The transcript model: durable Session events and live Assistant stream frames
 * folded into the ordered rows the terminal surface renders. The fold is pure
 * with respect to I/O, so rendering tests drive it with recorded events instead
 * of a terminal.
 * @module @deepseek-ai/dsh-tui-app/transcript
 */

import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord, ContentBlock, MessageSource, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { imageMarker } from './images.ts'
import type { ToolPresentationResolver } from './tool-view.ts'

/** A human prompt row. */
export interface UserEntry {
  kind: 'user'
  /** Row identity, stable for the life of the row. */
  id: number
  /** The prompt text, without the composer markers of its images. */
  text: string
  /** One label per attached image, in content order; empty for a text-only prompt. */
  images: readonly string[]
}

/** An assistant message row. */
export interface AssistantEntry {
  kind: 'assistant'
  /** Row identity; negative while the message is still streaming. */
  id: number
  /** The assembled visible text. */
  text: string
  /** Whether the turn was cancelled while this message streamed. */
  interrupted: boolean
}

/** Provider reasoning shown while it streams; the durable settlement keeps it out of the transcript. */
export interface ReasoningEntry {
  kind: 'reasoning'
  /** Row identity; always negative, since only live reasoning is rendered. */
  id: number
  /** The reasoning text streamed so far. */
  text: string
}

/** One Tool call and its settled outcome. */
export interface ToolEntry {
  kind: 'tool'
  /** Row identity, stable for the life of the row. */
  id: number
  /** Correlating call id. */
  callId: string
  /** Registered Tool name. */
  name: string
  /** Raw arguments JSON as the model produced it. */
  args: string
  /** Whether the call is still running or has settled. */
  status: 'running' | 'ok' | 'error'
  /** Visible result text, or empty while running. */
  result: string
  /** Failure identity when the Tool reported an error. */
  error?: string
  /** The presentation view the Tool declared for its call, when it declared one. */
  callView?: ToolCallView | undefined
  /** The presentation view the Tool declared for its settled result; absent keeps the call view. */
  resultView?: ToolResultView | undefined
}

/** An app-level account that belongs to no message: injected context, turn outcomes, discarded attempts. */
export interface NoticeEntry {
  kind: 'notice'
  /** Row identity, stable for the life of the row. */
  id: number
  /** Whether the row reads as a failure. */
  level: 'info' | 'error'
  /** One-line account of what happened. */
  text: string
}

/** One rendered row of the transcript. */
export type TranscriptEntry = UserEntry | AssistantEntry | ReasoningEntry | ToolEntry | NoticeEntry

/** Live assistant text row identity, below every durable row. */
const LIVE_ASSISTANT_ID = -2
/** Live reasoning row identity, below every durable row. */
const LIVE_REASONING_ID = -1

/**
 * Join the visible text of a content block list, ignoring non-text blocks.
 * @param blocks - message or tool-result content.
 * @returns the concatenated text blocks.
 */
export function textOfBlocks(blocks: readonly ContentBlock[]): string {
  let text = ''
  for (const block of blocks) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/**
 * Label one prompt's attached images in content order.
 * @param blocks - message content.
 * @returns the marker text for each image block, in order.
 */
function imageLabels(blocks: readonly ContentBlock[]): string[] {
  const labels: string[] = []
  for (const block of blocks) {
    if (block.type === 'image') labels.push(imageMarker(labels.length + 1))
  }
  return labels
}

/**
 * Reduce a compact Assistant stream to its terminal failure text.
 * @param stream - the embedded attempt stream.
 * @returns the failure message, or undefined when the attempt ended without one.
 */
function streamFailure(stream: readonly AssistantStreamRecord[]): string | undefined {
  for (const { chunk } of expandAssistantStream(stream)) {
    if (chunk.type !== 'finish') continue
    if (chunk.reason.kind === 'error') return chunk.reason.failure.message
    if (chunk.reason.kind === 'aborted') return chunk.reason.failure.message
  }
  return undefined
}

/**
 * The one-line account a producer declared for injected context.
 *
 * Injected context is model input rather than conversation, so the transcript
 * shows only rows whose producer declared a `notice` form; instructions,
 * catalogs, and state snapshots stay in the session log. `MessageSourceMap` is
 * merge-extensible and declares `form` only on the members that own one, so the
 * field is read from the source rather than from a `kind` switch.
 * @param source - the durable `user/message` source.
 * @returns the declared summary, or null when this source carries no notice.
 */
function noticeSummary(source: MessageSource): string | null {
  if (!('form' in source) || source.form !== 'notice') return null
  return source.summary === '' ? null : source.summary
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
 * Whether a decoded JSON value is an array, without widening its elements to `any`.
 * @param value - the decoded value.
 * @returns true when the value is an array.
 */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

/**
 * Render the answer batch a late `user-question-reply` message carries.
 *
 * The timed call's own result recorded the timeout, so this message is the only
 * record of what the user finally chose.
 * @param blocks - the reply message content.
 * @returns one `question → answer` line per answered question, or null when the text carries no readable batch.
 */
function lateReplyText(blocks: readonly ContentBlock[]): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(textOfBlocks(blocks))
  } catch (error) {
    // The durable text is the service's JSON batch; anything else is not one.
    void error
    return null
  }
  if (!isRecord(parsed) || !isUnknownArray(parsed.questions) || !isUnknownArray(parsed.answers)) return null
  const questions = parsed.questions
  const lines: string[] = []
  for (const answer of parsed.answers) {
    if (!isRecord(answer)) continue
    const id = typeof answer.id === 'string' ? answer.id : ''
    const selected = isUnknownArray(answer.selected)
      ? answer.selected.filter((label): label is string => typeof label === 'string')
      : []
    const custom = typeof answer.custom === 'string' ? answer.custom : undefined
    const value = selected.length > 0 ? selected.join(', ') : custom ?? '(skipped)'
    const question = questions.find(item => isRecord(item) && item.id === id)
    const label = isRecord(question) && typeof question.question === 'string' ? question.question : id
    lines.push(`${label} → ${value}`)
  }
  return lines.length === 0 ? null : lines.join('\n')
}

/**
 * Whether a settled `ask_user_question` result is the pending payload a timed
 * call returns when its window closes.
 * @param text - the tool result text.
 * @returns true when the result records a continued question.
 */
function isPendingQuestionResult(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) && parsed.pending === true
  } catch (error) {
    // A non-JSON result is an ordinary failure or answer, never the pending payload.
    void error
    return false
  }
}

/**
 * The ordered transcript of one Agent session. Durable rows come from the
 * session log; live rows come from `agent/assistant-stream` and are replaced by
 * their durable settlement.
 */
export class TerminalTranscript {
  private rows: TranscriptEntry[] = []
  private readonly toolByCallId = new Map<string, ToolEntry>()
  private nextId = 1
  private liveText = ''
  private liveReasoning = ''
  private attempt = false
  private changeCount = 0

  /**
   * @param views - resolves the diff card a Tool declared for its call and result;
   * absent keeps every Tool row in its raw name-and-summary form.
   */
  constructor(private readonly views?: ToolPresentationResolver) {}

  /** Monotone change counter; a view compares it to decide whether to rebuild. */
  get revision(): number {
    return this.changeCount
  }

  /** Whether an Assistant attempt is currently streaming. */
  get streaming(): boolean {
    return this.attempt
  }

  /**
   * The rows to render, in order: durable rows followed by the live attempt.
   * @returns the current transcript.
   */
  entries(): readonly TranscriptEntry[] {
    if (!this.attempt && this.liveText === '' && this.liveReasoning === '') return this.rows
    const live: TranscriptEntry[] = []
    if (this.liveReasoning !== '') {
      live.push({ kind: 'reasoning', id: LIVE_REASONING_ID, text: this.liveReasoning })
    }
    if (this.liveText !== '') {
      live.push({
        kind: 'assistant',
        id: LIVE_ASSISTANT_ID,
        text: this.liveText,
        interrupted: false,
      })
    }
    return [...this.rows, ...live]
  }

  /** Drop every row, for a new or resumed session. */
  reset(): void {
    this.rows = []
    this.toolByCallId.clear()
    this.liveText = ''
    this.liveReasoning = ''
    this.attempt = false
    this.changeCount += 1
  }

  /**
   * Fold one durable Session event into the transcript.
   * @param event - the appended event.
   * @returns whether the visible transcript changed.
   */
  applyEvent(event: SessionEvent): boolean {
    switch (event.type) {
      case 'user/message':
        return this.applyUserMessage(event.data)
      case 'assistant/message':
        return this.applyAssistantMessage(event.data)
      case 'assistant/attempt':
        return this.applyAttempt(event.data)
      case 'tool/call':
        return this.applyToolCall(event.data)
      case 'tool/result':
        return this.applyToolResult(event.data)
      case 'turn/end':
        return this.applyTurnEnd(event.data)
      default:
        // Log-only and plugin-extended events carry nothing the transcript shows.
        return false
    }
  }

  /**
   * Fold one live Assistant stream frame into the transcript.
   * @param frame - the published frame.
   * @returns whether the visible transcript changed.
   */
  applyFrame(frame: AssistantStreamFrame): boolean {
    switch (frame.type) {
      case 'start':
        this.attempt = true
        this.liveText = ''
        this.liveReasoning = ''
        return this.changed()
      case 'chunk':
        return this.applyChunk(frame.chunk)
      case 'end':
        if (frame.outcome.kind === 'abandoned') this.notice('info', 'the model stream ended without a settlement')
        this.attempt = false
        this.liveText = ''
        this.liveReasoning = ''
        return this.changed()
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(frame, 'assistant stream frame')
    }
  }

  private applyChunk(chunk: StreamChunk): boolean {
    switch (chunk.type) {
      case 'text-delta':
        if (chunk.text === '') return false
        this.liveText += chunk.text
        return this.changed()
      case 'reasoning-delta':
        if (chunk.text === '') return false
        this.liveReasoning += chunk.text
        return this.changed()
      case 'usage':
      case 'block-start':
      case 'block-end':
      case 'tool-call-delta':
      case 'finish':
        return false
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(chunk, 'assistant stream chunk')
    }
  }

  private applyUserMessage(message: SessionEvent<'user/message'>['data']): boolean {
    if (message.source.kind === 'user-question-reply') {
      const text = lateReplyText(message.content)
      if (text === null) return false
      this.rows.push({ kind: 'user', id: this.nextId++, text, images: [] })
      return this.changed()
    }
    if (message.source.kind !== 'user') {
      const summary = noticeSummary(message.source)
      if (summary === null) return false
      return this.notice('info', summary)
    }
    const text = textOfBlocks(message.content)
    const images = imageLabels(message.content)
    if (text === '' && images.length === 0) return false
    this.rows.push({ kind: 'user', id: this.nextId++, text, images })
    return this.changed()
  }

  private applyAssistantMessage(data: SessionEvent<'assistant/message'>['data']): boolean {
    const text = textOfBlocks(data.message.content)
    if (text === '') return false
    this.rows.push({
      kind: 'assistant',
      id: this.nextId++,
      text,
      interrupted: data.interrupted === true,
    })
    return this.changed()
  }

  private applyAttempt(data: SessionEvent<'assistant/attempt'>['data']): boolean {
    const failure = streamFailure(data.stream)
    if (failure === undefined) return false
    return this.notice('error', failure)
  }

  private applyToolCall(data: SessionEvent<'tool/call'>['data']): boolean {
    const row: ToolEntry = {
      kind: 'tool',
      id: this.nextId++,
      callId: data.callId,
      name: data.name,
      args: data.arguments,
      status: 'running',
      result: '',
    }
    const callView = this.views?.call(data.name, data.arguments)
    if (callView !== undefined) row.callView = callView
    this.rows.push(row)
    this.toolByCallId.set(data.callId, row)
    return this.changed()
  }

  private applyToolResult(data: SessionEvent<'tool/result'>['data']): boolean {
    const message = data.message
    const row = this.toolByCallId.get(message.toolCallId)
    if (row === undefined) return false
    const isError = message.isError === true
    row.status = isError ? 'error' : 'ok'
    row.result = textOfBlocks(message.content)
    if (data.error !== undefined) row.error = `${data.error.name}: ${data.error.code}`
    // A failed call's view no longer describes the outcome, so both views are
    // dropped and the raw error text is what the user needs. A successful
    // result installs the Tool's result view; a Tool that declares none (for
    // example `str_replace_editor`) keeps the call-time view, and an empty hunk
    // list clears the row back to raw rendering.
    if (isError) {
      row.callView = undefined
      row.resultView = undefined
    } else {
      const view = this.views?.result(row.name, row.args, {
        content: [...message.content],
        isError: false,
        ...data.meta === undefined ? {} : { meta: data.meta },
      })
      if (view !== undefined) {
        if (view.card === 'diff' && view.diffs.length === 0) {
          row.callView = undefined
          row.resultView = undefined
        } else {
          row.resultView = view
        }
      }
    }
    // A timed question that outlived its window stays answerable; the notice is
    // what tells the user the `/questions` command can still finish it.
    if (!isError && row.name === 'ask_user_question' && isPendingQuestionResult(row.result)) {
      this.notice('info', 'question waiting — /questions answers it')
    }
    return this.changed()
  }

  private applyTurnEnd(data: SessionEvent<'turn/end'>['data']): boolean {
    const reason = data.reason
    if (reason.kind === 'error') return this.notice('error', reason.error.message)
    if (reason.kind === 'aborted') return this.notice('info', 'turn cancelled')
    if (reason.kind === 'max-tokens') return this.notice('info', 'the model reached its output limit')
    return false
  }

  /**
   * Append an app-level notice row.
   * @param level - whether the row reads as a failure.
   * @param text - the one-line account, or a multi-line block.
   * @returns always true, since a row was appended.
   */
  notice(level: 'info' | 'error', text: string): boolean {
    this.rows.push({ kind: 'notice', id: this.nextId++, level, text })
    return this.changed()
  }

  private changed(): boolean {
    this.changeCount += 1
    return true
  }
}
