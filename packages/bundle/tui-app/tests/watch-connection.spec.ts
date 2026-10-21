/**
 * The watch connection's bounded queue, held-frame cut, heartbeat, and
 * close-once behavior over a fake HTTP response.
 */

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WATCH_CLIENT_MAX_QUEUED_FRAMES, WATCH_HEARTBEAT_MS, WatchConnection } from '../src/watch/server.ts'
import type { WatchAssistantFrame, WatchServerFrame, WatchSnapshotFrame } from '../src/watch/protocol.ts'

/** One in-memory ServerResponse with controllable write pressure. */
class FakeResponse extends EventEmitter {
  readonly chunks: string[] = []
  destroyed = false
  ended = false
  accepts = true
  throws = false
  headersSent = false

  write(payload: string): boolean {
    if (this.throws) throw new Error('socket gone')
    this.chunks.push(payload)
    return this.accepts
  }

  end(): void {
    this.ended = true
    this.emit('close')
  }

  destroy(): void {
    this.destroyed = true
    this.emit('close')
  }
}

/** One durable event frame. */
function eventFrame(seq: number): WatchServerFrame {
  return {
    type: 'event',
    event: { seq, type: 'turn/start', time: 0, data: { turn: 1 } },
  } as WatchServerFrame
}

/** One assistant start frame. */
function assistantFrame(revision: number): WatchAssistantFrame {
  return {
    type: 'start',
    attemptId: LlmAttemptId('attempt-1'),
    revision,
    startedAfterSeq: 0,
    turn: 1,
    step: 1,
  }
}

/** One minimal opening snapshot. */
const snapshot: WatchSnapshotFrame = {
  type: 'snapshot',
  serviceInstanceId: 'instance-1',
  header: { id: SessionId('child'), version: 4, createdAt: 0, isSeeded: false },
  cursor: 2,
  events: [],
  status: 'idle',
  assistantStream: { revision: 6 },
}

/** Collect the NDJSON frame types the fake response received. */
function frameTypes(response: FakeResponse): string[] {
  return response.chunks.map(line => (JSON.parse(line) as { type: string }).type)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('WatchConnection', () => {
  it('holds frames across a pause and cuts by cursor and arrival position', () => {
    vi.useFakeTimers()
    const response = new FakeResponse()
    let closes = 0
    const connection = new WatchConnection(response as never, () => { closes += 1 })
    connection.pause()
    connection.send(eventFrame(1))
    connection.send(eventFrame(3))
    connection.send({ type: 'status', status: 'idle' })
    connection.sendAssistant(assistantFrame(5), 5)
    connection.sendAssistant(assistantFrame(7), 7)
    connection.send({ type: 'assistant', frame: assistantFrame(8) })
    connection.sendSnapshot(snapshot)
    connection.resume(2, 6)

    expect(frameTypes(response)).toEqual(['snapshot', 'event', 'status', 'assistant', 'assistant'])
    const revisions = response.chunks.slice(3).map(line => (JSON.parse(line) as { frame: { revision: number } }).frame.revision)
    expect(revisions).toEqual([7, 8])
    connection.abort()
    expect(closes).toBe(1)
  })

  it('aborts when the held frame or byte bound is exceeded', () => {
    const byFrame = new FakeResponse()
    const frameConnection = new WatchConnection(byFrame as never, () => {})
    frameConnection.pause()
    for (let index = 0; index < WATCH_CLIENT_MAX_QUEUED_FRAMES; index += 1) {
      expect(frameConnection.send({ type: 'heartbeat' })).toBe(true)
    }
    expect(frameConnection.send({ type: 'heartbeat' })).toBe(false)
    expect(byFrame.destroyed).toBe(true)

    const byBytes = new FakeResponse()
    const byteConnection = new WatchConnection(byBytes as never, () => {})
    byteConnection.pause()
    expect(byteConnection.send({ type: 'error', message: 'x'.repeat(1_000_001) })).toBe(false)
    expect(byBytes.destroyed).toBe(true)
  })

  it('queues under backpressure and resumes on drain', () => {
    const response = new FakeResponse()
    const connection = new WatchConnection(response as never, () => {})
    response.accepts = false
    expect(connection.send({ type: 'heartbeat' })).toBe(true)
    expect(connection.send({ type: 'status', status: 'idle' })).toBe(true)
    expect(frameTypes(response)).toEqual(['heartbeat'])
    response.accepts = true
    response.emit('drain')
    expect(frameTypes(response)).toEqual(['heartbeat', 'status'])
    connection.end()
    expect(response.ended).toBe(true)
  })

  it('aborts a connection whose queued writes exceed the frame bound', () => {
    const response = new FakeResponse()
    const connection = new WatchConnection(response as never, () => {})
    response.accepts = false
    connection.send({ type: 'heartbeat' })
    for (let index = 0; index < WATCH_CLIENT_MAX_QUEUED_FRAMES; index += 1) {
      connection.send({ type: 'heartbeat' })
    }
    expect(connection.send({ type: 'heartbeat' })).toBe(false)
    expect(response.destroyed).toBe(true)
  })

  it('aborts when the response write throws', () => {
    const response = new FakeResponse()
    const connection = new WatchConnection(response as never, () => {})
    response.throws = true
    expect(connection.send({ type: 'heartbeat' })).toBe(true)
    expect(response.destroyed).toBe(true)
  })

  it('flushes held frames when ending and ignores later writes', () => {
    const response = new FakeResponse()
    const connection = new WatchConnection(response as never, () => {})
    connection.pause()
    connection.send({ type: 'heartbeat' })
    connection.end()
    expect(frameTypes(response)).toEqual(['heartbeat'])
    expect(response.ended).toBe(true)
    expect(connection.send({ type: 'heartbeat' })).toBe(false)
    connection.pause()
    connection.send({ type: 'heartbeat' })
    connection.resume(0, 0)
    connection.abort()
    connection.abort()
    connection.sendSnapshot(snapshot)
    expect(response.ended).toBe(true)
    expect(connection.writable).toBe(false)
  })

  it('notifies close once and emits heartbeats while open', () => {
    vi.useFakeTimers()
    const response = new FakeResponse()
    let closes = 0
    const connection = new WatchConnection(response as never, () => { closes += 1 })
    vi.advanceTimersByTime(WATCH_HEARTBEAT_MS)
    expect(frameTypes(response)).toEqual(['heartbeat'])
    response.emit('error')
    response.emit('close')
    connection.abort()
    expect(closes).toBe(1)
  })
})
