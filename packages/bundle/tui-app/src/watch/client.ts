/**
 * The viewing side of the local subagent stream: open one authenticated
 * loopback request, parse its NDJSON frames, and report a decoded snapshot and
 * ordered updates. This module never creates an Agent and never retries.
 * @module @deepseek-ai/dsh-tui-app/watch/client
 */

import { asRecord, WATCH_PROTOCOL_HEADER, WATCH_PROTOCOL_VERSION, WATCH_STREAM_PATH, WATCH_TOKEN_HEADER } from './protocol.ts'
import type {
  WatchAssistantFrame,
  WatchConnectionRecord,
  WatchExecutionState,
  WatchServerFrame,
  WatchSnapshotFrame,
} from './protocol.ts'
import type { AssistantStreamBaseline } from '@deepseek-ai/dsh-agent'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

/** Failure classes the viewer distinguishes. */
export type WatchStreamFailureKind =
  /** The service exists but refused this viewer: bad token, wrong version, or not viewable. */
  | 'refused'
  /** The service answered with malformed protocol data. */
  | 'protocol'
  /** The TCP/HTTP connection or body failed. */
  | 'network'
  /** The service reported an internal read failure. */
  | 'service'

/** Typed failure with a user-facing message. */
export class WatchStreamError extends Error {
  /**
   * @param kind - the failure class.
   * @param message - user-facing diagnostic.
   * @param status - HTTP status when the failure came from a response.
   */
  constructor(
    readonly kind: WatchStreamFailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'WatchStreamError'
  }
}

/** Opening snapshot and ordered updates delivered to one viewer. */
export interface WatchStreamHandlers {
  /** Apply the opening snapshot synchronously before any later frames are delivered. */
  onSnapshot(snapshot: WatchSnapshotFrame): void
  /** One later committed event. */
  onEvent(event: SessionEvent): void
  /** One later assistant frame. */
  onAssistant(frame: WatchAssistantFrame): void
  /** Execution state changed. */
  onStatus(status: WatchExecutionState): void
  /** The child finished one execution; the stream stays open for later runs. */
  onExecutionEnd(stopReason: string): void
  /** The service is shutting down. */
  onServiceClosed(): void
  /** The stream failed after the snapshot. */
  onFailure(error: WatchStreamError): void
}

/** One open watch stream. */
export interface WatchStream {
  /** The opening snapshot, already validated and decoded. */
  readonly snapshot: WatchSnapshotFrame
  /** Close the local side without reporting a failure. */
  close(): void
}

/** Milliseconds allowed for the opening snapshot before the viewer falls back. */
const OPEN_TIMEOUT_MS = 5_000

/**
 * Open one watch stream and wait for its snapshot.
 * @param record - the published connection record.
 * @param sessionId - the child session requested.
 * @param handlers - callbacks for frames after the snapshot.
 * @returns the snapshot and a close handle.
 * @throws {WatchStreamError} when the request, response, or opening frame fails.
 */
export async function openWatchStream(
  record: WatchConnectionRecord,
  sessionId: string,
  handlers: WatchStreamHandlers,
): Promise<WatchStream> {
  const url = new URL(WATCH_STREAM_PATH, record.address)
  url.searchParams.set('session', sessionId)
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort(new Error('the watch service did not answer in time')) }, OPEN_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        [WATCH_PROTOCOL_HEADER]: String(WATCH_PROTOCOL_VERSION),
        [WATCH_TOKEN_HEADER]: record.token,
      },
      signal: controller.signal,
      redirect: 'error',
    })
  } catch (error: unknown) {
    clearTimeout(timer)
    throw new WatchStreamError('network', `could not reach the watch service: ${errorMessage(error)}`)
  }
  if (!response.ok) {
    clearTimeout(timer)
    const detail = await response.text().catch(() => '')
    throw new WatchStreamError(
      response.status === 401 || response.status === 403 || response.status === 426 ? 'refused' : 'service',
      httpFailureMessage(response.status, detail),
      response.status,
    )
  }
  if (response.body === null) {
    clearTimeout(timer)
    throw new WatchStreamError('protocol', 'the watch response carried no body')
  }
  const body = response.body
  let finished = false
  let snapshot: WatchSnapshotFrame | undefined
  let openFailed!: (error: WatchStreamError) => void
  const opened = new Promise<WatchSnapshotFrame>((resolve, reject) => {
    openFailed = reject
    void (async () => {
      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        while (!finished) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          let newline = buffer.indexOf('\n')
          while (newline !== -1) {
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            newline = buffer.indexOf('\n')
            if (line.trim() === '') continue
            const frame = parseServerFrame(line)
            if (frame.type === 'snapshot') {
              if (snapshot !== undefined) {
                throw new WatchStreamError('protocol', 'the watch service sent a second snapshot')
              }
              if (frame.header.id !== sessionId) {
                throw new WatchStreamError('protocol', `the watch service sent session "${frame.header.id}" for "${sessionId}"`)
              }
              if (frame.serviceInstanceId !== record.serviceInstanceId) {
                throw new WatchStreamError('protocol', 'the watch service instance does not match the published record')
              }
              applySnapshot(frame, handlers)
              snapshot = frame
              clearTimeout(timer)
              resolve(frame)
              continue
            }
            if (snapshot === undefined) {
              if (frame.type === 'error') throw new WatchStreamError('service', frame.message)
              throw new WatchStreamError('protocol', 'the watch service sent data before its snapshot')
            }
            applyFrame(() => { dispatch(frame, handlers, () => { finished = true }) })
            if (frame.type === 'service-closed') finished = true
          }
        }
        if (snapshot === undefined) {
          throw new WatchStreamError('protocol', 'the watch service closed before its snapshot')
        }
        if (!finished) {
          handlers.onFailure(new WatchStreamError('network', 'the watch connection ended'))
        }
      } catch (error: unknown) {
        if (finished) return
        finished = true
        const failure = error instanceof WatchStreamError
          ? error
          : new WatchStreamError('network', errorMessage(error))
        if (snapshot === undefined) openFailed(failure)
        else handlers.onFailure(failure)
      } finally {
        clearTimeout(timer)
        reader.releaseLock()
      }
    })()
  })
  let openedSnapshot: WatchSnapshotFrame
  try {
    openedSnapshot = await opened
  } catch (error: unknown) {
    controller.abort()
    throw error
  }
  return {
    snapshot: openedSnapshot,
    close: () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      controller.abort()
    },
  }
}

/**
 * Dispatch one post-snapshot frame.
 * @param frame - the decoded frame.
 * @param handlers - viewer callbacks.
 * @param stop - marks the stream finished for a terminal frame.
 */
function applySnapshot(frame: WatchSnapshotFrame, handlers: WatchStreamHandlers): void {
  try {
    handlers.onSnapshot(frame)
  } catch (error: unknown) {
    throw error instanceof WatchStreamError
      ? error
      : new WatchStreamError('protocol', `the watch viewer could not apply the snapshot: ${errorMessage(error)}`)
  }
}

/**
 * Apply one post-snapshot frame, classifying a fold failure as malformed
 * protocol data rather than a network failure.
 * @param action - the dispatch to run.
 */
function applyFrame(action: () => void): void {
  try {
    action()
  } catch (error: unknown) {
    throw error instanceof WatchStreamError
      ? error
      : new WatchStreamError('protocol', `the watch viewer could not apply the frame: ${errorMessage(error)}`)
  }
}

/**
 * Dispatch one post-snapshot frame.
 * @param frame - the decoded frame.
 * @param handlers - viewer callbacks.
 * @param stop - marks the stream finished for a terminal frame.
 */
function dispatch(frame: Exclude<WatchServerFrame, WatchSnapshotFrame>, handlers: WatchStreamHandlers, stop: () => void): void {
  switch (frame.type) {
    case 'event': handlers.onEvent(frame.event); return
    case 'assistant': handlers.onAssistant(frame.frame); return
    case 'status': handlers.onStatus(frame.status); return
    case 'heartbeat': return
    case 'execution-end': handlers.onExecutionEnd(frame.stopReason); return
    case 'service-closed':
      handlers.onServiceClosed()
      stop()
      return
    case 'error':
      handlers.onFailure(new WatchStreamError('service', frame.message))
      stop()
      return
    /* v8 ignore next -- closed union exhaustiveness guard */
    default:
      throw new WatchStreamError('protocol', `unknown watch frame: ${String(frame)}`)
  }
}

/**
 * Parse and validate one NDJSON line.
 * @param line - one complete JSON line without its terminator.
 * @returns the validated frame.
 * @throws {WatchStreamError} when the line is malformed or unknown.
 */
export function parseServerFrame(line: string): WatchServerFrame {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (error: unknown) {
    throw new WatchStreamError('protocol', `malformed watch frame: ${errorMessage(error)}`)
  }
  const frame = asRecord(value)
  if (frame === undefined || typeof frame.type !== 'string') {
    throw new WatchStreamError('protocol', 'the watch service sent a frame without a type')
  }
  switch (frame.type) {
    case 'snapshot':
      return parseSnapshot(frame)
    case 'event': {
      assertSessionEvent(frame.event)
      return { type: 'event', event: frame.event }
    }
    case 'assistant': {
      assertAssistantFrame(frame.frame)
      return { type: 'assistant', frame: frame.frame }
    }
    case 'status': {
      if (frame.status !== 'running' && frame.status !== 'idle') {
        throw new WatchStreamError('protocol', 'the watch service sent an unknown execution state')
      }
      return { type: 'status', status: frame.status }
    }
    case 'heartbeat':
      return { type: 'heartbeat' }
    case 'execution-end':
      if (typeof frame.stopReason !== 'string') {
        throw new WatchStreamError('protocol', 'the watch service sent an execution end without a reason')
      }
      return { type: 'execution-end', stopReason: frame.stopReason }
    case 'service-closed':
      return { type: 'service-closed' }
    case 'error':
      if (typeof frame.message !== 'string') {
        throw new WatchStreamError('protocol', 'the watch service sent an error without a message')
      }
      return { type: 'error', message: frame.message }
    default:
      throw new WatchStreamError('protocol', `unknown watch frame type: ${JSON.stringify(frame.type)}`)
  }
}

/** Validate the opening snapshot fields the viewer uses. */
function parseSnapshot(frame: Record<string, unknown>): WatchSnapshotFrame {
  assertSessionHeader(frame.header)
  const cursor = frame.cursor
  if ((cursor !== -1 && !isNonNegativeSafeInteger(cursor)) || !Array.isArray(frame.events)) {
    throw new WatchStreamError('protocol', 'the watch snapshot has no valid event cut')
  }
  if (frame.status !== 'running' && frame.status !== 'idle') {
    throw new WatchStreamError('protocol', 'the watch snapshot has no valid execution state')
  }
  const events: SessionEvent[] = []
  for (const event of frame.events) {
    assertSessionEvent(event)
    events.push(event)
  }
  if (typeof frame.serviceInstanceId !== 'string' || frame.serviceInstanceId === '') {
    throw new WatchStreamError('protocol', 'the watch snapshot has no service identity')
  }
  return {
    type: 'snapshot',
    serviceInstanceId: frame.serviceInstanceId,
    header: frame.header,
    cursor,
    events,
    status: frame.status,
    assistantStream: parseAssistantBaseline(frame.assistantStream),
  }
}

/** Validate the assistant baseline enough to replay its active attempt. */
function parseAssistantBaseline(value: unknown): AssistantStreamBaseline {
  const baseline = asRecord(value)
  if (baseline === undefined || !isNonNegativeSafeInteger(baseline.revision)) {
    throw new WatchStreamError('protocol', 'the watch snapshot has no valid assistant baseline')
  }
  if (baseline.activeAttempt === undefined) return { revision: baseline.revision }
  const attempt = asRecord(baseline.activeAttempt)
  if (attempt === undefined
    || typeof attempt.attemptId !== 'string'
    || !isCursor(attempt.startedAfterSeq)
    || !isNonNegativeSafeInteger(attempt.turn)
    || !isNonNegativeSafeInteger(attempt.step)
    || !isNonNegativeSafeInteger(attempt.nextIndex)
    || !Array.isArray(attempt.stream)) {
    throw new WatchStreamError('protocol', 'the watch snapshot has a malformed active attempt')
  }
  const stream: AssistantStreamRecord[] = []
  for (const record of attempt.stream) {
    assertAssistantStreamRecord(record)
    stream.push(record)
  }
  return {
    revision: baseline.revision,
    activeAttempt: {
      attemptId: LlmAttemptId(attempt.attemptId),
      startedAfterSeq: attempt.startedAfterSeq === -1 ? -1 : SessionSeq(attempt.startedAfterSeq),
      turn: attempt.turn,
      step: attempt.step,
      nextIndex: attempt.nextIndex,
      stream,
    },
  }
}

/** Assert the header fields the viewer and transcript read. */
function assertSessionHeader(value: unknown): asserts value is SessionHeader {
  const header = asRecord(value)
  if (header === undefined
    || typeof header.id !== 'string'
    || !isNonNegativeSafeInteger(header.version)
    || !isNonNegativeSafeInteger(header.createdAt)
    || typeof header.isSeeded !== 'boolean') {
    throw new WatchStreamError('protocol', 'the watch snapshot has no valid session header')
  }
}

/**
 * Assert the durable event envelope and the payload fields the transcript reads.
 *
 * Event types this viewer does not render stay envelope-only because the event
 * map is merge-extensible; the visible types carry stricter field checks so a
 * malformed payload fails as protocol data instead of throwing inside the fold.
 */
function assertSessionEvent(value: unknown): asserts value is SessionEvent {
  const event = asRecord(value)
  const data = event === undefined ? undefined : asRecord(event.data)
  if (event === undefined
    || !isNonNegativeSafeInteger(event.seq)
    || typeof event.type !== 'string'
    || !isNonNegativeSafeInteger(event.time)
    || data === undefined) {
    throw new WatchStreamError('protocol', 'the watch service sent a malformed event')
  }
  switch (event.type) {
    case 'user/message':
      if (data.role !== 'user') throw malformedEvent()
      assertMessageBody(data)
      return
    case 'assistant/message': {
      const message = asRecord(data.message)
      if (message === undefined || message.role !== 'assistant') throw malformedEvent()
      assertMessageBody(message)
      if (data.interrupted !== undefined && typeof data.interrupted !== 'boolean') throw malformedEvent()
      return
    }
    case 'assistant/attempt':
      if (!Array.isArray(data.stream)) throw malformedEvent()
      for (const record of data.stream) assertAssistantStreamRecord(record)
      return
    case 'tool/call':
      if (typeof data.callId !== 'string'
        || typeof data.name !== 'string'
        || typeof data.arguments !== 'string') {
        throw malformedEvent()
      }
      return
    case 'tool/result': {
      const message = asRecord(data.message)
      if (message === undefined
        || message.role !== 'tool'
        || typeof message.toolCallId !== 'string'
        || (message.isError !== undefined && typeof message.isError !== 'boolean')) {
        throw malformedEvent()
      }
      assertMessageBody(message)
      if (data.error !== undefined) {
        const error = asRecord(data.error)
        if (error === undefined || typeof error.name !== 'string' || typeof error.code !== 'string') throw malformedEvent()
      }
      return
    }
    case 'turn/end': {
      const reason = asRecord(data.reason)
      if (reason === undefined || typeof reason.kind !== 'string') throw malformedEvent()
      if (reason.kind === 'error') {
        const failure = asRecord(reason.error)
        if (failure === undefined || typeof failure.message !== 'string') throw malformedEvent()
      }
      return
    }
    default:
      return
  }
}

/** Throw the one malformed-event protocol diagnostic. */
function malformedEvent(): WatchStreamError {
  return new WatchStreamError('protocol', 'the watch service sent a malformed event')
}

/** Assert a message's content and source fields that the transcript reads. */
function assertMessageBody(message: Record<string, unknown>): void {
  if (!Array.isArray(message.content)) throw malformedEvent()
  for (const value of message.content) {
    const block = asRecord(value)
    if (block === undefined || typeof block.type !== 'string') throw malformedEvent()
    if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text !== 'string') {
      throw malformedEvent()
    }
  }
  const source = asRecord(message.source)
  if (source === undefined || typeof source.kind !== 'string') throw malformedEvent()
  if (source.form !== undefined && typeof source.form !== 'string') throw malformedEvent()
  if (source.form === 'notice' && typeof source.summary !== 'string') throw malformedEvent()
}

/** Whether a value is a non-negative safe integer. */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Whether a value is a Session cursor: -1 or a non-negative safe integer. */
function isCursor(value: unknown): value is number {
  return value === -1 || isNonNegativeSafeInteger(value)
}

/** Assert one assistant wire frame. */
function assertAssistantFrame(value: unknown): asserts value is WatchAssistantFrame {
  const frame = asRecord(value)
  if (frame === undefined || typeof frame.type !== 'string') {
    throw new WatchStreamError('protocol', 'the watch service sent a malformed assistant frame')
  }
  if (typeof frame.attemptId !== 'string' || !isNonNegativeSafeInteger(frame.revision)) {
    throw new WatchStreamError('protocol', 'the watch service sent an assistant frame without identity')
  }
  switch (frame.type) {
    case 'start':
      if (!isCursor(frame.startedAfterSeq)
        || !isNonNegativeSafeInteger(frame.turn)
        || !isNonNegativeSafeInteger(frame.step)) {
        throw new WatchStreamError('protocol', 'the watch service sent a malformed assistant start')
      }
      return
    case 'chunk':
      if (!isNonNegativeSafeInteger(frame.index) || !isNonNegativeSafeInteger(frame.time)) {
        throw new WatchStreamError('protocol', 'the watch service sent a malformed assistant chunk')
      }
      assertStreamChunk(frame.chunk)
      return
    case 'end': {
      const outcome = asRecord(frame.outcome)
      if (!isNonNegativeSafeInteger(frame.index) || outcome === undefined) {
        throw new WatchStreamError('protocol', 'the watch service sent a malformed assistant end')
      }
      if (outcome.kind === 'committed') {
        if ((outcome.eventType !== 'assistant/message' && outcome.eventType !== 'assistant/attempt')
          || !isNonNegativeSafeInteger(outcome.seq)) {
          throw new WatchStreamError('protocol', 'the watch service sent a malformed assistant settlement')
        }
        return
      }
      if (outcome.kind !== 'abandoned') {
        throw new WatchStreamError('protocol', 'the watch service sent an unknown assistant outcome')
      }
      return
    }
    default:
      throw new WatchStreamError('protocol', `unknown assistant frame type: ${JSON.stringify(frame.type)}`)
  }
}

/** Assert one compact stream record before replaying it through the transcript. */
function assertAssistantStreamRecord(value: unknown): asserts value is AssistantStreamRecord {
  const record = asRecord(value)
  if (record === undefined) throw new WatchStreamError('protocol', 'the watch snapshot stream is not a record')
  switch (record.type) {
    case 'text-chunks':
    case 'reasoning-chunks':
      if (!isNonNegativeSafeInteger(record.time0)
        || !isNonNegativeSafeInteger(record.index)
        || !isNumberArray(record.dt)
        || !isStringArray(record.texts)) {
        throw new WatchStreamError('protocol', 'the watch snapshot has a malformed text stream')
      }
      return
    case 'tool-call-chunks':
      if (!isNonNegativeSafeInteger(record.time0)
        || !isNonNegativeSafeInteger(record.index)
        || !isNumberArray(record.dt)
        || typeof record.id !== 'string'
        || !isStringArray(record.args)) {
        throw new WatchStreamError('protocol', 'the watch snapshot has a malformed tool stream')
      }
      return
    case 'chunk':
      if (!isNonNegativeSafeInteger(record.time)) {
        throw new WatchStreamError('protocol', 'the watch snapshot has a malformed chunk record')
      }
      assertStreamChunk(record.chunk)
      return
    default:
      throw new WatchStreamError('protocol', `unknown snapshot stream record: ${JSON.stringify(record.type)}`)
  }
}

/** Validate stream chunks; only block events and deltas carry a block index. */
function assertStreamChunk(value: unknown): asserts value is StreamChunk {
  const chunk = asRecord(value)
  if (chunk === undefined || typeof chunk.type !== 'string') {
    throw new WatchStreamError('protocol', 'the watch service sent a malformed stream chunk')
  }
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      if (typeof chunk.index !== 'number' || typeof chunk.text !== 'string') {
        throw new WatchStreamError('protocol', 'the watch service sent a malformed text delta')
      }
      return
    case 'tool-call-delta':
      if (typeof chunk.index !== 'number' || typeof chunk.id !== 'string' || typeof chunk.argumentsDelta !== 'string') {
        throw new WatchStreamError('protocol', 'the watch service sent a malformed tool delta')
      }
      return
    case 'block-start':
      if (typeof chunk.index !== 'number' || typeof chunk.blockType !== 'string') {
        throw new WatchStreamError('protocol', 'the watch service sent a malformed block start')
      }
      return
    case 'block-end':
      if (typeof chunk.index !== 'number' || asRecord(chunk.block) === undefined) {
        throw new WatchStreamError('protocol', 'the watch service sent a malformed block end')
      }
      return
    case 'usage':
      if (asRecord(chunk.usage) === undefined) throw new WatchStreamError('protocol', 'the watch service sent malformed usage')
      return
    case 'finish': {
      const reason = asRecord(chunk.reason)
      if (reason === undefined || typeof reason.kind !== 'string') {
        throw new WatchStreamError('protocol', 'the watch service sent a malformed finish')
      }
      if (reason.kind === 'error' || reason.kind === 'aborted') {
        const failure = asRecord(reason.failure)
        if (failure === undefined || typeof failure.message !== 'string') {
          throw new WatchStreamError('protocol', 'the watch service sent a malformed finish failure')
        }
      }
      return
    }
    default:
      throw new WatchStreamError('protocol', `unknown stream chunk type: ${JSON.stringify(chunk.type)}`)
  }
}

/**
 * Render one HTTP failure for the viewer.
 * @param status - response status.
 * @param detail - response body text.
 * @returns a one-line diagnostic.
 */
function httpFailureMessage(status: number, detail: string): string {
  switch (status) {
    case 401: return 'the watch service rejected the access token'
    case 403: return 'the watch service denied that session'
    case 404: return 'the watch service no longer serves that session'
    case 426: return 'the watch service uses an incompatible protocol'
    default: return `the watch service failed (HTTP ${String(status)})${detail === '' ? '' : `: ${detail.trim()}`}`
  }
}

/**
 * Render an unknown rejection for a diagnostic.
 * @param error - the rejected value.
 * @returns its message or string form.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether every member is a finite number. */
function isNumberArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every(item => typeof item === 'number' && Number.isFinite(item))
}

/** Whether every member is a string. */
function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}
