/**
 * The watch client's transport failures and wire validation for snapshots,
 * durable events, assistant frames, and compact attempt records.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { openWatchStream, parseServerFrame, WatchStreamError } from '../src/watch/client.ts'
import type { WatchStreamHandlers } from '../src/watch/client.ts'
import type { WatchConnectionRecord } from '../src/watch/protocol.ts'
import { WATCH_PROTOCOL_VERSION } from '../src/watch/protocol.ts'

const record: WatchConnectionRecord = {
  protocol: WATCH_PROTOCOL_VERSION,
  serviceInstanceId: 'instance-1',
  sessionId: 'child' as never,
  rootSessionId: 'root' as never,
  address: 'http://127.0.0.1:1234',
  token: 'test-token',
}

const header: SessionHeader = {
  id: 'child' as never,
  version: 4,
  createdAt: 0,
  isSeeded: false,
}

const validUser = {
  seq: 0,
  type: 'user/message',
  time: 0,
  data: { role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
}

/** One complete opening snapshot. */
function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'snapshot',
    serviceInstanceId: 'instance-1',
    header,
    cursor: 0,
    events: [validUser],
    status: 'idle',
    assistantStream: { revision: 0 },
    ...overrides,
  }
}

/** Complete viewer handlers with spies. */
function handlers(overrides: Partial<WatchStreamHandlers> = {}): WatchStreamHandlers {
  return {
    onSnapshot: vi.fn(),
    onEvent: vi.fn(),
    onAssistant: vi.fn(),
    onStatus: vi.fn(),
    onExecutionEnd: vi.fn(),
    onServiceClosed: vi.fn(),
    onFailure: vi.fn(),
    ...overrides,
  }
}

/** A response whose body stays open until `close`. */
function openBody(lines: string[]): { response: Response; close: () => void } {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
      if (lines.length > 0) value.enqueue(encoder.encode(`${lines.join('\n')}\n`))
    },
  })
  return { response: new Response(stream), close: () => { controller?.close() } }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('openWatchStream transport failures', () => {
  it.each([401, 403, 404, 426, 500])('rejects HTTP %i with its class and message', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('detail', { status }))
    const failure = await openWatchStream(record, 'child', handlers()).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WatchStreamError)
    expect((failure as WatchStreamError).status).toBe(status)
    expect((failure as WatchStreamError).kind).toBe(status === 401 || status === 403 || status === 426 ? 'refused' : 'service')
  })

  it('renders a generic HTTP failure with and without detail', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 500 }))
    const empty = await openWatchStream(record, 'child', handlers()).catch((error: unknown) => error)
    expect((empty as WatchStreamError).message).toBe('the watch service failed (HTTP 500)')

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('detail', { status: 500 }))
    const detailed = await openWatchStream(record, 'child', handlers()).catch((error: unknown) => error)
    expect((detailed as WatchStreamError).message).toBe('the watch service failed (HTTP 500): detail')
  })

  it('does not let a failed HTTP body read hide the status', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error('body failed')) },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 500 }))
    const failure = await openWatchStream(record, 'child', handlers()).catch((error: unknown) => error)
    expect((failure as WatchStreamError).message).toBe('the watch service failed (HTTP 500)')
  })

  it('reports an unreachable service through both Error and non-Error rejections', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('connection refused'))
    const error = await openWatchStream(record, 'child', handlers()).catch((value: unknown) => value)
    expect((error as WatchStreamError).message).toContain('connection refused')

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce('connection refused')
    const plain = await openWatchStream(record, 'child', handlers()).catch((value: unknown) => value)
    expect((plain as WatchStreamError).message).toContain('connection refused')
  })

  it('aborts a request that receives no response before the opening timeout', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    }))
    const pending = openWatchStream(record, 'child', handlers()).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5_000)
    const failure = await pending
    expect((failure as WatchStreamError).message).toContain('could not reach the watch service: aborted')
  })

  it('reports a raw body read failure as a network failure', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error('read failed')) },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body))
    const failure = await openWatchStream(record, 'child', handlers()).catch((error: unknown) => error)
    expect((failure as WatchStreamError).message).toBe('read failed')
  })

  it('preserves a WatchStreamError thrown by a fold handler', async () => {
    const snapshotBody = openBody([JSON.stringify(snapshot())])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(snapshotBody.response)
    const snapshotError = new WatchStreamError('protocol', 'snapshot says no')
    const snapshotFailure = await openWatchStream(record, 'child', handlers({
      onSnapshot: () => { throw snapshotError },
    })).catch((error: unknown) => error)
    expect(snapshotFailure).toBe(snapshotError)
    snapshotBody.close()

    const frameBody = openBody([
      JSON.stringify(snapshot()),
      JSON.stringify({ type: 'status', status: 'idle' }),
    ])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(frameBody.response)
    const frameError = new WatchStreamError('protocol', 'frame says no')
    const onFailure = vi.fn()
    const stream = await openWatchStream(record, 'child', handlers({
      onStatus: () => { throw frameError }, onFailure,
    }))
    await vi.waitFor(() => { expect(onFailure).toHaveBeenCalledWith(frameError) })
    stream.close()
    frameBody.close()
  })

  it('rejects a response without a body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
    const failure = await openWatchStream(record, 'child', handlers()).catch((error: unknown) => error)
    expect((failure as WatchStreamError).message).toContain('carried no body')
  })

  it('skips blank lines and resolves the first snapshot', async () => {
    const body = openBody(['', '', JSON.stringify(snapshot())])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(body.response)
    const stream = await openWatchStream(record, 'child', handlers())
    expect(stream.snapshot.header.id).toBe('child')
    stream.close()
    stream.close()
    body.close()
  })

  it('reports a second snapshot after the opening cut', async () => {
    const body = openBody([JSON.stringify(snapshot()), JSON.stringify(snapshot())])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(body.response)
    const onFailure = vi.fn()
    const stream = await openWatchStream(record, 'child', handlers({ onFailure }))
    await vi.waitFor(() => { expect(onFailure).toHaveBeenCalled() })
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ kind: 'protocol' }))
    stream.close()
    body.close()
  })

  it('rejects a mismatched session or service before the snapshot', async () => {
    for (const lines of [
      [JSON.stringify(snapshot({ header: { ...header, id: 'other' } }))],
      [JSON.stringify(snapshot({ serviceInstanceId: 'other' }))],
    ]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(`${lines.join('\n')}\n`))
      await expect(openWatchStream(record, 'child', handlers())).rejects.toBeInstanceOf(WatchStreamError)
    }
  })

  it('rejects data before the snapshot and a stream that closes before it', async () => {
    for (const lines of [
      [JSON.stringify({ type: 'status', status: 'idle' })],
      [],
    ]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(lines.length === 0 ? '' : `${lines.join('\n')}\n`))
      const failure = await openWatchStream(record, 'child', handlers()).catch((error: unknown) => error)
      expect((failure as WatchStreamError).kind).toBe('protocol')
    }
  })

  it('dispatches every post-snapshot frame and settles on service-closed', async () => {
    const event = { seq: 1, type: 'turn/start', time: 1, data: { turn: 1 } }
    const body = openBody([
      JSON.stringify(snapshot()),
      JSON.stringify({ type: 'status', status: 'running' }),
      JSON.stringify({ type: 'heartbeat' }),
      JSON.stringify({ type: 'execution-end', stopReason: 'completed' }),
      JSON.stringify({ type: 'assistant', frame: { type: 'start', attemptId: 'a', revision: 1, startedAfterSeq: 0, turn: 1, step: 1 } }),
      JSON.stringify({ type: 'event', event }),
      JSON.stringify({ type: 'service-closed' }),
    ])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(body.response)
    const onServiceClosed = vi.fn()
    const onStatus = vi.fn()
    const onExecutionEnd = vi.fn()
    const onAssistant = vi.fn()
    const onEvent = vi.fn()
    const onFailure = vi.fn()
    const stream = await openWatchStream(record, 'child', handlers({
      onServiceClosed, onStatus, onExecutionEnd, onAssistant, onEvent, onFailure,
    }))
    await vi.waitFor(() => { expect(onServiceClosed).toHaveBeenCalled() })
    expect(onStatus).toHaveBeenCalledWith('running')
    expect(onExecutionEnd).toHaveBeenCalledWith('completed')
    expect(onAssistant).toHaveBeenCalled()
    expect(onEvent).toHaveBeenCalledWith(event)
    expect(onFailure).not.toHaveBeenCalled()
    stream.close()
    body.close()
  })

  it('reports an error frame after the snapshot as a service failure', async () => {
    const body = openBody([
      JSON.stringify(snapshot()),
      JSON.stringify({ type: 'error', message: 'service failed' }),
    ])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(body.response)
    const onFailure = vi.fn()
    const stream = await openWatchStream(record, 'child', handlers({ onFailure }))
    await vi.waitFor(() => { expect(onFailure).toHaveBeenCalled() })
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'service',
      message: 'service failed',
    }))
    stream.close()
    body.close()
  })

  it('reports a connection that ends after the snapshot', async () => {
    const body = openBody([JSON.stringify(snapshot())])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(body.response)
    const onFailure = vi.fn()
    const stream = await openWatchStream(record, 'child', handlers({ onFailure }))
    body.close()
    await vi.waitFor(() => { expect(onFailure).toHaveBeenCalled() })
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ kind: 'network' }))
    stream.close()
  })

  it('classifies a snapshot or frame fold rejection as protocol data', async () => {
    const snapshotBody = openBody([JSON.stringify(snapshot())])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(snapshotBody.response)
    const snapshotFailure = await openWatchStream(record, 'child', handlers({
      onSnapshot: () => { throw new Error('snapshot fold failed') },
    })).catch((error: unknown) => error)
    expect((snapshotFailure as WatchStreamError).message).toContain('snapshot fold failed')
    snapshotBody.close()

    const frameBody = openBody([
      JSON.stringify(snapshot()),
      JSON.stringify({ type: 'status', status: 'idle' }),
    ])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(frameBody.response)
    const onFailure = vi.fn()
    const stream = await openWatchStream(record, 'child', handlers({
      onStatus: () => { throw 'plain fold failure' }, onFailure,
    }))
    await vi.waitFor(() => { expect(onFailure).toHaveBeenCalled() })
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'protocol',
      message: 'the watch viewer could not apply the frame: plain fold failure',
    }))
    stream.close()
    frameBody.close()
  })
})

describe('parseServerFrame', () => {
  it('accepts every visible durable event type', () => {
    const events = [
      validUser,
      {
        seq: 1, type: 'assistant/message', time: 1,
        data: {
          message: {
            role: 'assistant',
            content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'answer' }],
            source: { kind: 'model' },
          },
          interrupted: true,
        },
      },
      {
        seq: 2, type: 'assistant/attempt', time: 2,
        data: { turn: 1, step: 1, stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'bad' } } } }] },
      },
      { seq: 3, type: 'tool/call', time: 3, data: { turn: 1, step: 1, callId: 'call', name: 'read', arguments: '{}' } },
      {
        seq: 4, type: 'tool/result', time: 4,
        data: {
          turn: 1, step: 1,
          message: { role: 'tool', toolCallId: 'call', content: [], source: { kind: 'tool' }, isError: true },
          error: { name: 'E', code: 'C' },
          meta: { diff: 'x' },
        },
      },
      { seq: 5, type: 'turn/end', time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
      { seq: 6, type: 'turn/end', time: 6, data: { turn: 1, reason: { kind: 'error', error: { message: 'bad' } } } },
    ]
    for (const [index, event] of events.entries()) {
      expect(parseServerFrame(JSON.stringify({ type: 'event', event }))).toEqual({ type: 'event', event })
      expect(parseServerFrame(JSON.stringify(snapshot({ cursor: index, events: [event] }))).type).toBe('snapshot')
    }
  })

  it('accepts a tool result with and without an error identity', () => {
    const plain = {
      seq: 0, type: 'tool/result', time: 0,
      data: {
        turn: 1, step: 1,
        message: { role: 'tool', toolCallId: 'call', content: [], source: { kind: 'tool' } },
      },
    }
    expect(parseServerFrame(JSON.stringify({ type: 'event', event: plain }))).toEqual({ type: 'event', event: plain })
    const event = {
      seq: 0, type: 'tool/result', time: 0,
      data: {
        turn: 1, step: 1,
        message: { role: 'tool', toolCallId: 'call', content: [], source: { kind: 'tool' }, isError: true },
        error: { name: 'E', code: 'C' },
      },
    }
    expect(parseServerFrame(JSON.stringify({ type: 'event', event }))).toEqual({ type: 'event', event })
  })

  it('rejects malformed envelopes and visible payloads', () => {
    const bad = [
      null,
      {},
      { seq: -1, type: 'turn/start', time: 0, data: {} },
      { seq: 0, type: 1, time: 0, data: {} },
      { seq: 0, type: 'turn/start', time: -1, data: {} },
      { seq: 0, type: 'turn/start', time: 0, data: 1 },
      { seq: 0, type: 'user/message', time: 0, data: { role: 'assistant', content: [], source: { kind: 'user' } } },
      { seq: 0, type: 'user/message', time: 0, data: { role: 'user', content: [], source: {} } },
      { seq: 0, type: 'user/message', time: 0, data: { role: 'user', content: {}, source: { kind: 'user' } } },
      { seq: 0, type: 'user/message', time: 0, data: { role: 'user', content: [1], source: { kind: 'user' } } },
      { seq: 0, type: 'user/message', time: 0, data: { role: 'user', content: [{ type: 1 }], source: { kind: 'user' } } },
      { seq: 0, type: 'user/message', time: 0, data: { role: 'user', content: [{ type: 'text' }], source: { kind: 'user' } } },
      { seq: 0, type: 'user/message', time: 0, data: { role: 'user', content: [], source: { kind: 'user', form: 1 } } },
      { seq: 0, type: 'user/message', time: 0, data: { role: 'user', content: [], source: { kind: 'user', form: 'notice' } } },
      { seq: 0, type: 'assistant/message', time: 0, data: { message: { role: 'user', content: [], source: { kind: 'user' } } } },
      { seq: 0, type: 'assistant/message', time: 0, data: { message: { role: 'assistant', content: [], source: { kind: 'model' } }, interrupted: 1 } },
      { seq: 0, type: 'assistant/attempt', time: 0, data: { stream: {} } },
      { seq: 0, type: 'tool/call', time: 0, data: { callId: 'c', name: 'n' } },
      { seq: 0, type: 'tool/result', time: 0, data: { message: { role: 'assistant' } } },
      { seq: 0, type: 'tool/result', time: 0, data: { message: { role: 'tool', toolCallId: 'c', content: [], source: { kind: 'tool' }, isError: 1 } } },
      { seq: 0, type: 'tool/result', time: 0, data: { message: { role: 'tool', toolCallId: 'c', content: [], source: { kind: 'tool' } }, error: {} } },
      { seq: 0, type: 'turn/end', time: 0, data: {} },
      { seq: 0, type: 'turn/end', time: 0, data: { reason: { kind: 'error', error: {} } } },
    ]
    for (const event of bad) {
      expect(() => parseServerFrame(JSON.stringify({ type: 'event', event }))).toThrow('malformed event')
    }
  })

  it('validates snapshot headers, cuts, status, identity, and baselines', () => {
    const bad = [
      snapshot({ header: undefined }),
      snapshot({ header: { ...header, id: 1 } }),
      snapshot({ header: { ...header, version: -1 } }),
      snapshot({ header: { ...header, createdAt: -1 } }),
      snapshot({ header: { ...header, isSeeded: 'no' } }),
      snapshot({ cursor: -2 }),
      snapshot({ cursor: 1.5 }),
      snapshot({ cursor: '0' }),
      snapshot({ events: {} }),
      snapshot({ status: 'busy' }),
      snapshot({ serviceInstanceId: '' }),
      snapshot({ serviceInstanceId: 1 }),
      snapshot({ assistantStream: undefined }),
      snapshot({ assistantStream: { revision: -1 } }),
      snapshot({ assistantStream: { revision: 0, activeAttempt: { attemptId: 1 } } }),
      snapshot({ assistantStream: { revision: 0, activeAttempt: { attemptId: 'a', startedAfterSeq: -2, turn: 1, step: 1, nextIndex: 0, stream: [] } } }),
      snapshot({ assistantStream: { revision: 0, activeAttempt: { attemptId: 'a', startedAfterSeq: 0, turn: 1, step: 1, nextIndex: 0, stream: {} } } }),
      snapshot({ assistantStream: { revision: 0, activeAttempt: { attemptId: 'a', startedAfterSeq: 0, turn: 1, step: 1, nextIndex: 0, stream: [1] } } }),
    ]
    for (const frame of bad) {
      expect(() => parseServerFrame(JSON.stringify(frame))).toThrow(WatchStreamError)
    }
    expect(parseServerFrame(JSON.stringify(snapshot({
      assistantStream: {
        revision: 2,
        activeAttempt: {
          attemptId: 'a', startedAfterSeq: -1, turn: 1, step: 1, nextIndex: 1,
          stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [], texts: ['x'] }],
        },
      },
    }))).type).toBe('snapshot')
  })

  it('validates assistant frame identity, type, and outcomes', () => {
    const bad = [
      null,
      {},
      { type: 'start', attemptId: 1, revision: 1, startedAfterSeq: 0, turn: 1, step: 1 },
      { type: 'start', attemptId: 'a', revision: -1, startedAfterSeq: 0, turn: 1, step: 1 },
      { type: 'start', attemptId: 'a', revision: 1, startedAfterSeq: -2, turn: 1, step: 1 },
      { type: 'start', attemptId: 'a', revision: 1, startedAfterSeq: 0, turn: -1, step: 1 },
      { type: 'start', attemptId: 'a', revision: 1, startedAfterSeq: 0, turn: 1, step: 1.5 },
      { type: 'chunk', attemptId: 'a', revision: 1, index: -1, time: 0, chunk: { type: 'text-delta', index: 0, text: 'x' } },
      { type: 'chunk', attemptId: 'a', revision: 1, index: 0, time: -1, chunk: { type: 'text-delta', index: 0, text: 'x' } },
      { type: 'end', attemptId: 'a', revision: 1, index: -1, outcome: { kind: 'abandoned' } },
      { type: 'end', attemptId: 'a', revision: 1, index: 0, outcome: undefined },
      { type: 'end', attemptId: 'a', revision: 1, index: 0, outcome: { kind: 'committed', eventType: 'turn/end', seq: 0 } },
      { type: 'end', attemptId: 'a', revision: 1, index: 0, outcome: { kind: 'committed', eventType: 'assistant/message', seq: -1 } },
      { type: 'end', attemptId: 'a', revision: 1, index: 0, outcome: { kind: 'other' } },
      { type: 'other', attemptId: 'a', revision: 1 },
    ]
    for (const frame of bad) {
      expect(() => parseServerFrame(JSON.stringify({ type: 'assistant', frame }))).toThrow(WatchStreamError)
    }
    expect(parseServerFrame(JSON.stringify({
      type: 'assistant',
      frame: { type: 'end', attemptId: 'a', revision: 1, index: 0, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 0 } },
    })).type).toBe('assistant')
    expect(parseServerFrame(JSON.stringify({
      type: 'assistant',
      frame: { type: 'end', attemptId: 'a', revision: 1, index: 0, outcome: { kind: 'abandoned' } },
    })).type).toBe('assistant')
  })

  it('validates compact stream records and chunks', () => {
    const badRecords = [
      null,
      { type: 'text-chunks', time0: -1, index: 0, dt: [], texts: ['x'] },
      { type: 'text-chunks', time0: 0, index: -1, dt: [], texts: ['x'] },
      { type: 'text-chunks', time0: 0, index: 0, dt: [1], texts: [1] },
      { type: 'tool-call-chunks', time0: 0, index: 0, dt: [], id: 1, args: ['x'] },
      { type: 'tool-call-chunks', time0: 0, index: 0, dt: [], id: 'c', args: [1] },
      { type: 'chunk', time: -1, chunk: { type: 'usage', usage: {} } },
      { type: 'other' },
    ]
    for (const record of badRecords) {
      expect(() => parseServerFrame(JSON.stringify(snapshot({
        assistantStream: { revision: 1, activeAttempt: { attemptId: 'a', startedAfterSeq: 0, turn: 1, step: 1, nextIndex: 0, stream: [record] } },
      })))).toThrow(WatchStreamError)
    }
    expect(parseServerFrame(JSON.stringify(snapshot({
      assistantStream: {
        revision: 1,
        activeAttempt: {
          attemptId: 'a', startedAfterSeq: 0, turn: 1, step: 1, nextIndex: 1,
          stream: [{ type: 'tool-call-chunks', time0: 0, index: 0, dt: [], id: 'c', args: ['{}'] }],
        },
      },
    }))).type).toBe('snapshot')

    const badChunks = [
      null,
      {},
      { type: 'text-delta', index: 0, text: 1 },
      { type: 'tool-call-delta', index: 0, id: 1, argumentsDelta: '' },
      { type: 'block-start', index: 0, blockType: 1 },
      { type: 'block-end', index: 0, block: 1 },
      { type: 'usage', usage: 1 },
      { type: 'finish', reason: 1 },
      { type: 'finish', reason: { kind: 'error', failure: {} } },
      { type: 'other' },
    ]
    for (const chunk of badChunks) {
      expect(() => parseServerFrame(JSON.stringify({
        type: 'assistant', frame: { type: 'chunk', attemptId: 'a', revision: 1, index: 0, time: 0, chunk },
      }))).toThrow(WatchStreamError)
    }
    expect(parseServerFrame(JSON.stringify({
      type: 'assistant',
      frame: { type: 'chunk', attemptId: 'a', revision: 1, index: 0, time: 0, chunk: { type: 'finish', reason: { kind: 'aborted', failure: { message: 'stop' } } } },
    })).type).toBe('assistant')
  })

  it('rejects malformed frames, unknown statuses, and missing fields', () => {
    expect(() => parseServerFrame('{')).toThrow('malformed watch frame')
    expect(() => parseServerFrame('[]')).toThrow('frame without a type')
    expect(() => parseServerFrame('{}')).toThrow('frame without a type')
    expect(() => parseServerFrame('{"type":"other"}')).toThrow('unknown watch frame type')
    expect(() => parseServerFrame('{"type":"status"}')).toThrow('unknown execution state')
    expect(() => parseServerFrame('{"type":"execution-end"}')).toThrow('without a reason')
    expect(() => parseServerFrame('{"type":"error"}')).toThrow('error without a message')
    expect(parseServerFrame('{"type":"heartbeat"}')).toEqual({ type: 'heartbeat' })
    expect(parseServerFrame('{"type":"service-closed"}')).toEqual({ type: 'service-closed' })
  })
})
