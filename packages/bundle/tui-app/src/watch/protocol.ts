/**
 * The local subagent-watch wire protocol shared by the publishing TUI and the
 * read-only viewer. Frames are NDJSON; a connection opens with exactly one
 * snapshot and then carries ordered events, assistant frames, status, and
 * heartbeats.
 * @module @deepseek-ai/dsh-tui-app/watch/protocol
 */

import type { AssistantStreamFrame, AssistantStreamBaseline } from '@deepseek-ai/dsh-agent'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { LlmAttemptId, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Wire version a publisher and viewer must share. */
export const WATCH_PROTOCOL_VERSION = 1

/** Request header carrying the random access token. */
export const WATCH_TOKEN_HEADER = 'x-dsh-watch-token'

/** Request header carrying the wire version. */
export const WATCH_PROTOCOL_HEADER = 'x-dsh-watch-protocol'

/** Stream path, always queried with `?session=<id>`. */
export const WATCH_STREAM_PATH = '/v1/stream'

/** Execution state the publisher reports in the footer. */
export type WatchExecutionState = 'running' | 'idle'

/** How the viewer obtained the transcript. */
export type WatchConnectionState = 'online' | 'history' | 'disconnected'

/** One published connection record under the runtime directory. */
export interface WatchConnectionRecord {
  /** Wire version this record was written for. */
  readonly protocol: typeof WATCH_PROTOCOL_VERSION
  /** Process-local service identity; records from another instance are not ours to delete. */
  readonly serviceInstanceId: string
  /** Child session this record addresses. */
  readonly sessionId: SessionId
  /** Root session whose tree the service serves. */
  readonly rootSessionId: SessionId
  /** Loopback HTTP origin, for example `http://127.0.0.1:43121`. */
  readonly address: string
  /** Random bearer token; never placed in a command, URL, or log. */
  readonly token: string
}

/** One assistant frame on the watch wire; `start` carries the durable cursor. */
export type WatchAssistantFrame =
  | {
    readonly type: 'start'
    readonly attemptId: LlmAttemptId
    readonly revision: number
    readonly startedAfterSeq: number
    readonly turn: number
    readonly step: number
  }
  | {
    readonly type: 'chunk'
    readonly attemptId: LlmAttemptId
    readonly revision: number
    readonly index: number
    readonly time: number
    readonly chunk: StreamChunk
  }
  | {
    readonly type: 'end'
    readonly attemptId: LlmAttemptId
    readonly revision: number
    readonly index: number
    readonly outcome:
      | {
        readonly kind: 'committed'
        readonly eventType: 'assistant/message' | 'assistant/attempt'
        readonly seq: number
      }
      | { readonly kind: 'abandoned' }
  }

/** Opening snapshot: a complete cut plus the live assistant baseline. */
export interface WatchSnapshotFrame {
  readonly type: 'snapshot'
  /** Service identity the viewer compares with its record. */
  readonly serviceInstanceId: string
  /** Session header the viewer shows and validates. */
  readonly header: SessionHeader
  /** Last event seq included in `events`, or -1 for an empty log. */
  readonly cursor: number
  /** Committed events in sequence order. */
  readonly events: readonly SessionEvent[]
  /** Current Agent lifecycle state. */
  readonly status: WatchExecutionState
  /** Process-local assistant state at this revision. */
  readonly assistantStream: AssistantStreamBaseline
}

/** One frame the publisher sends after the opening snapshot. */
export type WatchServerFrame =
  | WatchSnapshotFrame
  | { readonly type: 'event'; readonly event: SessionEvent }
  | { readonly type: 'assistant'; readonly frame: WatchAssistantFrame }
  | { readonly type: 'status'; readonly status: WatchExecutionState }
  /** Keeps an otherwise idle stream inside transport body timeouts. */
  | { readonly type: 'heartbeat' }
  | { readonly type: 'execution-end'; readonly stopReason: string }
  | { readonly type: 'service-closed' }
  | { readonly type: 'error'; readonly message: string }

/**
 * Encode a session id as a filesystem-safe record name.
 * @param sessionId - the child session id.
 * @returns URL-safe base64 of the UTF-8 id.
 */
export function encodeSessionRecordName(sessionId: string): string {
  return Buffer.from(sessionId, 'utf8').toString('base64url')
}

/**
 * Convert one process-local frame to its wire form.
 * @param frame - the Agent frame.
 * @param durableCursor - last committed seq observed when the frame arrived.
 * @returns the wire frame; `start` carries the cursor.
 */
export function wireAssistantFrame(frame: AssistantStreamFrame, durableCursor: number): WatchAssistantFrame {
  switch (frame.type) {
    case 'start':
      return { ...frame, startedAfterSeq: durableCursor }
    case 'chunk':
      return frame
    case 'end':
      return frame
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default:
      throw new Error(`unreachable assistant frame: ${String(frame)}`)
  }
}

/**
 * Convert one wire frame back to the Agent shape the transcript folds.
 * @param frame - the wire frame.
 * @returns the Agent frame, with the wire-only cursor dropped from `start`.
 */
export function agentAssistantFrame(frame: WatchAssistantFrame): AssistantStreamFrame {
  switch (frame.type) {
    case 'start':
      return {
        type: 'start',
        attemptId: frame.attemptId,
        revision: frame.revision,
        turn: frame.turn,
        step: frame.step,
      }
    case 'chunk':
      return { ...frame }
    case 'end':
      if (frame.outcome.kind === 'abandoned') {
        return { type: 'end', attemptId: frame.attemptId, revision: frame.revision, index: frame.index, outcome: { kind: 'abandoned' } }
      }
      return {
        type: 'end',
        attemptId: frame.attemptId,
        revision: frame.revision,
        index: frame.index,
        outcome: { kind: 'committed', eventType: frame.outcome.eventType, seq: SessionSeq(frame.outcome.seq) },
      }
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default:
      throw new Error(`unreachable watch frame: ${String(frame)}`)
  }
}

/**
 * Whether a string names a loopback HTTP origin this viewer may connect to.
 * @param address - candidate origin from a record.
 * @returns true only for a bare `http://127.0.0.1:<port>` origin.
 */
export function isLoopbackWatchAddress(address: string): boolean {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return false
  }
  return url.protocol === 'http:'
    && url.hostname === '127.0.0.1'
    && url.username === ''
    && url.password === ''
    && (url.pathname === '/' || url.pathname === '')
    && url.search === ''
    && url.hash === ''
}

/**
 * Parse one JSON value from a record or wire frame.
 *
 * Both are file/wire boundaries, so object and field checks live here rather
 * than in the consumers that trust the parsed value.
 * @param value - decoded JSON.
 * @returns the value when it is a non-null, non-array object.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Parse a connection record read from disk.
 * @param value - decoded JSON.
 * @returns the validated record.
 * @throws when the record is corrupt, for another protocol, or not loopback.
 */
export function parseWatchConnectionRecord(value: unknown): WatchConnectionRecord {
  const record = asRecord(value)
  if (record === undefined) throw new Error('the watch connection record is not a JSON object')
  if (record.protocol !== WATCH_PROTOCOL_VERSION) {
    throw new Error(`the watch connection record uses protocol ${String(record.protocol)}, expected ${String(WATCH_PROTOCOL_VERSION)}`)
  }
  for (const field of ['serviceInstanceId', 'sessionId', 'rootSessionId', 'address', 'token'] as const) {
    if (typeof record[field] !== 'string' || record[field] === '') {
      throw new Error(`the watch connection record has no valid ${field}`)
    }
  }
  const address = record.address as string
  if (!isLoopbackWatchAddress(address)) {
    throw new Error(`the watch connection record addresses a non-loopback service: ${JSON.stringify(address)}`)
  }
  return {
    protocol: WATCH_PROTOCOL_VERSION,
    serviceInstanceId: record.serviceInstanceId as string,
    sessionId: record.sessionId as SessionId,
    rootSessionId: record.rootSessionId as SessionId,
    address,
    token: record.token as string,
  }
}
