/**
 * The transcript model: durable Session events and live Assistant stream frames
 * folded into the ordered rows the terminal surface renders. The fold is pure
 * with respect to I/O, so rendering tests drive it with recorded events instead
 * of a terminal.
 * @module @deepseek-ai/dsh-tui-app/transcript
 */

import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord, ContentBlock, MessageSource, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** A human prompt row. */
export interface UserEntry {
  kind: 'user'
  /** Row identity, stable for the life of the row. */
  id: number
  /** The prompt text. */
  text: string
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
 * The ordered transcript of one Agent session. Durable rows come from the
 * session log; live rows come from `agent/assistant-stream` and are replaced by
 * their durable settlement.
 */
export class Transcript {
  private rows: TranscriptEntry[] = []
  private readonly toolByCallId = new Map<string, ToolEntry>()
  private nextId = 1
  private liveText = ''
  private liveReasoning = ''
  private attempt = false
  private liveUsage: TokenUsage | undefined
  private changeCount = 0

  /** Monotone change counter; a view compares it to decide whether to rebuild. */
  get revision(): number {
    return this.changeCount
  }

  /** Token accounting reported by the most recent provider stream, when any. */
  get usage(): TokenUsage | undefined {
    return this.liveUsage
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
    this.liveUsage = undefined
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
        this.liveUsage = undefined
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
        this.liveUsage = chunk.usage
        return this.changed()
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
    if (message.source.kind !== 'user') {
      const summary = noticeSummary(message.source)
      if (summary === null) return false
      return this.notice('info', summary)
    }
    const text = textOfBlocks(message.content)
    if (text === '') return false
    this.rows.push({ kind: 'user', id: this.nextId++, text })
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
    this.rows.push(row)
    this.toolByCallId.set(data.callId, row)
    return this.changed()
  }

  private applyToolResult(data: SessionEvent<'tool/result'>['data']): boolean {
    const block = data.message.content[0]
    const row = this.toolByCallId.get(block.toolCallId)
    if (row === undefined) return false
    row.status = block.isError === true ? 'error' : 'ok'
    row.result = textOfBlocks(block.content)
    if (data.error !== undefined) row.error = `${data.error.name}: ${data.error.code}`
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
