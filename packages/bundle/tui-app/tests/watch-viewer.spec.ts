/**
 * The read-only watch viewer's boot selection, history fallback, footer,
 * protocol guards, assistant replay, and usage projection.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-query'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { internals } from '../src/app.ts'
import { createTheme } from '../src/ansi.ts'
import { publishWatchRecord, watchRecordPath } from '../src/watch/record.ts'
import { WatchApp, WatchStatusBar } from '../src/watch/viewer.ts'
import { WATCH_PROTOCOL_VERSION } from '../src/watch/protocol.ts'
import { FakeTerminal } from './support/fake-terminal.ts'

const originalInternals = { ...internals }
const contexts: Context[] = []
const homes: string[] = []

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-watch-viewer-'))
  homes.push(home)
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  Object.assign(internals, originalInternals)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

/** A stored child session with no events. */
function childSession(id = 'session-child'): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, undefined, {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 0,
    isSeeded: false,
    origin: 'subagent',
  })
}

/** Publish a stored read handle. */
function persistence(ctx: Context, header: SessionHeader, events: readonly SessionEvent[]): void {
  ctx.provide('sessionPersistence', {
    async open() {
      return {
        header,
        async read() { return { events, eventState: 'shared-frozen' } },
        close: () => Promise.resolve(),
      }
    },
  } as never)
}

/** Install the process-facing test hooks. */
function prepareTerminal(): FakeTerminal {
  const terminal = new FakeTerminal()
  internals.isInteractive = () => true
  internals.createTerminal = () => terminal
  internals.copyClipboardText = async () => true
  return terminal
}

/** Boot a history viewer over one stored cut. */
async function bootHistory(
  header: SessionHeader,
  events: readonly SessionEvent[],
  extra?: (ctx: Context) => void,
  screen: 'inline' | 'alternate' = 'inline',
): Promise<{ app: WatchApp; terminal: FakeTerminal; exits: number[]; ctx: Context }> {
  const ctx = new Context()
  contexts.push(ctx)
  persistence(ctx, header, events)
  extra?.(ctx)
  const terminal = prepareTerminal()
  const exits: number[] = []
  const app = await WatchApp.boot({
    ctx,
    config: { screen, colorScheme: 'auto' },
    watch: header.id,
    exit: (code) => { exits.push(code) },
  })
  return { app, terminal, exits, ctx }
}

/** Call one private WatchApp member. */
function invoke(app: WatchApp, name: string, ...args: unknown[]): unknown {
  const method = Reflect.get(app, name) as (...values: unknown[]) => unknown
  return method.apply(app, args)
}

/** A turn start event. */
function turnStart(seq: number): SessionEvent {
  return { seq, type: 'turn/start', time: seq, data: { turn: 1 } } as SessionEvent
}

/** A response stream that stays open for incremental frames. */
function openBody(lines: string[]): { response: Response; close: () => void } {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
      value.enqueue(encoder.encode(`${lines.join('\n')}\n`))
    },
  })
  return { response: new Response(stream), close: () => { controller?.close() } }
}

describe('WatchStatusBar', () => {
  it('places the connection group at the edge and truncates on narrow widths', () => {
    const bar = new WatchStatusBar(createTheme({ enabled: false, palette: 'dark' }))
    bar.invalidate()
    bar.set({ sessionId: 'short', connection: 'online', execution: 'running' })
    expect(bar.render(200)[2]).toContain('online')
    expect(bar.render(200)[2]).toContain('running')
    bar.set({ sessionId: 'short', connection: 'online', execution: 'running' })
    expect(bar.render(20)[2]).toContain('online'.slice(0, 0))
    bar.set({ sessionId: 'x'.repeat(80), connection: 'online', execution: 'idle' })
    expect(bar.render(20)).toHaveLength(4)
  })
})

describe('WatchApp boot and history', () => {
  it('requires an interactive terminal', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    internals.isInteractive = () => false
    await expect(WatchApp.boot({
      ctx, config: { screen: 'inline', colorScheme: 'auto' }, watch: 'child', exit: () => {},
    })).rejects.toThrow('interactive terminal')
  })

  it('reports an unreadable record instead of treating it as absent', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    prepareTerminal()
    await publishWatchRecord({
      protocol: WATCH_PROTOCOL_VERSION,
      serviceInstanceId: 'instance-1',
      sessionId: SessionId('child'),
      rootSessionId: SessionId('root'),
      address: 'http://127.0.0.1:1234',
      token: 'secret',
    })
    await writeFile(watchRecordPath('child'), '{not json', 'utf8')
    await expect(WatchApp.boot({
      ctx, config: { screen: 'inline', colorScheme: 'auto' }, watch: 'child', exit: () => {},
    })).rejects.toThrow('could not read the watch record')
  })

  it('opens online, replays an active attempt, and applies live frames', async () => {
    const child = childSession('online-child')
    const ctx = new Context()
    contexts.push(ctx)
    const terminal = prepareTerminal()
    const copied: string[] = []
    internals.copyClipboardText = async (_text, write) => { write('copied'); copied.push('copied'); return true }
    await publishWatchRecord({
      protocol: WATCH_PROTOCOL_VERSION,
      serviceInstanceId: 'instance-1',
      sessionId: child.id,
      rootSessionId: SessionId('root'),
      address: 'http://127.0.0.1:1234',
      token: 'secret',
    })
    const frames = [
      {
        type: 'snapshot',
        serviceInstanceId: 'instance-1',
        header: child.header,
        cursor: 0,
        events: [turnStart(0)],
        status: 'idle',
        assistantStream: {
          revision: 1,
          activeAttempt: {
            attemptId: 'attempt-1', startedAfterSeq: -1, turn: 1, step: 1, nextIndex: 1,
            stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [], texts: ['hi'] }],
          },
        },
      },
      {
        type: 'assistant',
        frame: { type: 'chunk', attemptId: 'attempt-1', revision: 2, index: 1, time: 1, chunk: { type: 'text-delta', index: 0, text: '!' } },
      },
      { type: 'event', event: { seq: 1, type: 'turn/end', time: 1, data: { turn: 1, reason: { kind: 'completed' } } } },
      { type: 'status', status: 'running' },
      { type: 'execution-end', stopReason: 'completed' },
      { type: 'service-closed' },
    ]
    const body = openBody(frames.map(frame => JSON.stringify(frame)))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(body.response)
    const app = await WatchApp.boot({
      ctx, config: { screen: 'alternate', colorScheme: 'auto' }, watch: child.id, exit: () => {},
    })
    const transcript = Reflect.get(app, 'transcript') as { entries(): readonly { kind: string; text?: string }[] }
    await vi.waitFor(() => {
      expect(transcript.entries().some(entry => entry.kind === 'assistant' && entry.text === 'hi!')).toBe(true)
    })
    await vi.waitFor(() => { expect(Reflect.get(app, 'connection')).toBe('disconnected') })
    const copySelection = Reflect.get(app, 'copySelection') as (text: string) => Promise<boolean>
    expect(await copySelection('selection')).toBe(true)
    expect(copied).toEqual(['copied'])
    expect(terminal.output).toBeDefined()
    app.stop(0)
    body.close()
  })

  it('rethrows a non-network online failure but falls back for a network failure', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const session = childSession()
    persistence(ctx, session.header, [])
    prepareTerminal()
    await publishWatchRecord({
      protocol: WATCH_PROTOCOL_VERSION,
      serviceInstanceId: 'instance-1',
      sessionId: session.id,
      rootSessionId: SessionId('root'),
      address: 'http://127.0.0.1:1',
      token: 'secret',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }))
    await expect(WatchApp.boot({
      ctx, config: { screen: 'inline', colorScheme: 'auto' }, watch: session.id, exit: () => {},
    })).rejects.toMatchObject({ kind: 'refused' })

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    const terminal = prepareTerminal()
    const exits: number[] = []
    const app = await WatchApp.boot({
      ctx, config: { screen: 'inline', colorScheme: 'auto' }, watch: session.id, exit: (code) => { exits.push(code) },
    })
    expect(Reflect.get(app, 'connection')).toBe('history')
    terminal.feed('\u001b')
    await vi.waitFor(() => { expect(exits).toEqual([0]) })
  })

  it('opens an idle online snapshot with no active attempt and no trailing frames', async () => {
    const child = childSession('idle-child')
    const ctx = new Context()
    contexts.push(ctx)
    prepareTerminal()
    await publishWatchRecord({
      protocol: WATCH_PROTOCOL_VERSION,
      serviceInstanceId: 'instance-1',
      sessionId: child.id,
      rootSessionId: SessionId('root'),
      address: 'http://127.0.0.1:1234',
      token: 'secret',
    })
    const body = openBody([JSON.stringify({
      type: 'snapshot',
      serviceInstanceId: 'instance-1',
      header: child.header,
      cursor: -1,
      events: [],
      status: 'idle',
      assistantStream: { revision: 0 },
    })])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(body.response)
    const app = await WatchApp.boot({
      ctx, config: { screen: 'inline', colorScheme: 'auto' }, watch: child.id, exit: () => {},
    })
    expect(Reflect.get(app, 'connection')).toBe('online')
    expect(Reflect.get(app, 'failed')).toBe(false)
    app.stop(0)
    body.close()
  })

  it('reports a history read failure', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    prepareTerminal()
    ctx.provide('sessionPersistence', {
      async open() { throw new Error('stored log unreadable') },
    } as never)
    await expect(WatchApp.boot({
      ctx, config: { screen: 'inline', colorScheme: 'auto' }, watch: 'session-child', exit: () => {},
    })).rejects.toThrow('could not read session "session-child": stored log unreadable')
  })

  it('reports a history header that names another session at the fold', async () => {
    const session = childSession()
    const { app, terminal, exits } = await bootHistory(session.header, [])
    invoke(app, 'applyHistory', { ...session.header, id: SessionId('other-child') }, [])
    const transcript = Reflect.get(app, 'transcript') as { entries(): readonly { kind: string; text?: string }[] }
    expect(Reflect.get(app, 'failed')).toBe(true)
    expect(transcript.entries().some(entry => entry.kind === 'notice' && entry.text?.includes('history names session'))).toBe(true)
    terminal.feed('\u0004')
    await vi.waitFor(() => { expect(exits).toEqual([0]) })
  })

  it('reports a gap in a stored history cut', async () => {
    const session = childSession()
    prepareTerminal()
    const ctx = new Context()
    contexts.push(ctx)
    persistence(ctx, session.header, [turnStart(1)])
    const app = await WatchApp.boot({
      ctx, config: { screen: 'inline', colorScheme: 'auto' }, watch: session.id, exit: () => {},
    })
    const transcript = Reflect.get(app, 'transcript') as { entries(): readonly { kind: string; text?: string }[] }
    expect(transcript.entries().some(entry => entry.kind === 'notice' && entry.text?.includes('followed -1'))).toBe(true)
    expect(Reflect.get(app, 'failed')).toBe(true)
  })

  it('measures seeded history through the projection registry', async () => {
    const session = childSession()
    const events = [
      { seq: 0, type: 'session/end-seed', time: 0, data: { inherited: true } },
      turnStart(1),
    ] as SessionEvent[]
    const restore = vi.fn(() => ({
      checkpoint: { seen: 1 },
      snapshot: {
        asOfSeq: 1,
        values: {
          contextPressure: { contextWindow: 100, projectedTokens: 40 },
          tokenUsage: { uncachedInputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1, outputTokens: 3 },
          sessionStats: { decodeMs: 1_000, decodeTokens: 20 },
        },
      },
    }))
    const { app } = await bootHistory({ ...session.header, isSeeded: true }, events, (ctx) => {
      ctx.provide('sessionProjections', { restore } as never)
    })
    expect(restore).toHaveBeenCalled()
    const measurement = Reflect.get(app, 'measurement') as { context?: unknown; stats: { outputTokens: number } }
    expect(measurement.stats.outputTokens).toBe(3)
    expect(measurement.context).toBeDefined()
  })

  it('measures an empty cut and a seeded cut without an inherited marker', async () => {
    const session = childSession()
    const restore = vi.fn(() => ({ checkpoint: {}, snapshot: { asOfSeq: 0, values: {} } }))
    await bootHistory(session.header, [], (ctx) => {
      ctx.provide('sessionProjections', { restore } as never)
    })
    expect(restore).toHaveBeenCalled()
    await bootHistory({ ...session.header, isSeeded: true }, [turnStart(0)], (ctx) => {
      ctx.provide('sessionProjections', { restore } as never)
    })
  })

  it('skips measurement before a header is known', async () => {
    const session = childSession()
    const { app } = await bootHistory(session.header, [])
    Reflect.set(app, 'header', undefined)
    expect(() => { invoke(app, 'measureEvents', [turnStart(0)]) }).not.toThrow()
  })
})

describe('WatchApp protocol guards', () => {
  it('leaves twice, repaints with Ctrl+L, and ignores key releases', async () => {
    const session = childSession()
    const { app, terminal, exits } = await bootHistory(session.header, [])
    app.stop(0)
    app.stop(0)
    expect(exits).toEqual([0])
    expect(terminal.output).toBeDefined()
  })

  it('repaints on Ctrl+L and ignores a release', async () => {
    const session = childSession()
    const { terminal, exits, app } = await bootHistory(session.header, [])
    terminal.feed('\u000c')
    terminal.feed('x')
    terminal.feed('\u001b[108;5:3u')
    terminal.feed('\u001b')
    await vi.waitFor(() => { expect(exits).toEqual([0]) })
    app.stop(0)
  })

  it('reports a snapshot cut mismatch and closes the just-opened stream', async () => {
    const session = childSession()
    const ctx = new Context()
    contexts.push(ctx)
    prepareTerminal()
    await publishWatchRecord({
      protocol: WATCH_PROTOCOL_VERSION,
      serviceInstanceId: 'instance-1',
      sessionId: session.id,
      rootSessionId: SessionId('root'),
      address: 'http://127.0.0.1:1234',
      token: 'secret',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`${JSON.stringify({
      type: 'snapshot',
      serviceInstanceId: 'instance-1',
      header: session.header,
      cursor: 0,
      events: [],
      status: 'idle',
      assistantStream: { revision: 0 },
    })}\n`))
    const app = await WatchApp.boot({
      ctx, config: { screen: 'inline', colorScheme: 'auto' }, watch: session.id, exit: () => {},
    })
    expect(Reflect.get(app, 'failed')).toBe(true)
    expect(Reflect.get(app, 'stream')).toBeUndefined()
  })

  it('replays an active attempt and rejects a chunk-count mismatch', async () => {
    const session = childSession()
    const { app } = await bootHistory(session.header, [])
    expect(() => { invoke(app, 'replayAttempt', { revision: 0 }) }).not.toThrow()
    expect(() => {
      invoke(app, 'replayAttempt', {
        revision: 1,
        activeAttempt: {
          attemptId: 'a', startedAfterSeq: 0, turn: 1, step: 1, nextIndex: 2,
          stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [], texts: ['x'] }],
        },
      })
    }).toThrow('holds 1 chunks')
  })

  it('reports a non-Error baseline failure through protocolFailure', async () => {
    const session = childSession()
    const { app } = await bootHistory(session.header, [])
    Reflect.set(app, 'replayAttempt', () => { throw 'bad baseline' })
    invoke(app, 'applySnapshot', {
      header: session.header,
      cursor: -1,
      events: [],
      status: 'idle',
      assistantStream: {
        revision: 1,
        activeAttempt: { attemptId: 'a', startedAfterSeq: -1, turn: 1, step: 1, nextIndex: 0, stream: [] },
      },
    })
    expect(Reflect.get(app, 'failed')).toBe(true)
  })

  it('guards event continuity before and after the first event', async () => {
    const session = childSession()
    const { app } = await bootHistory(session.header, [])
    invoke(app, 'onEvent', turnStart(1))
    expect(Reflect.get(app, 'failed')).toBe(true)
    expect(Reflect.get(app, 'failed')).toBe(true)
  })

  it('guards assistant revision, attempt, chunk, and end mismatches', async () => {
    const session = childSession()
    const { app } = await bootHistory(session.header, [])
    const frame = (value: Record<string, unknown>): void => { invoke(app, 'onAssistant', value) }
    frame({ type: 'start', attemptId: 'a', revision: 1, startedAfterSeq: 0, turn: 1, step: 1 })
    frame({ type: 'chunk', attemptId: 'b', revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: 'x' } })
    expect(Reflect.get(app, 'failed')).toBe(true)

    const second = await bootHistory(session.header, [])
    const secondFrame = (value: Record<string, unknown>): void => { invoke(second.app, 'onAssistant', value) }
    secondFrame({ type: 'start', attemptId: 'a', revision: 1, startedAfterSeq: 0, turn: 1, step: 1 })
    invoke(second.app, 'onAssistant', {
      type: 'chunk', attemptId: 'a', revision: 3, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: 'x' },
    })
    expect(Reflect.get(second.app, 'failed')).toBe(true)

    const third = await bootHistory(session.header, [])
    invoke(third.app, 'onAssistant', { type: 'start', attemptId: 'a', revision: 1, startedAfterSeq: 0, turn: 1, step: 1 })
    invoke(third.app, 'onAssistant', {
      type: 'chunk', attemptId: 'a', revision: 2, index: 1, time: 0, chunk: { type: 'text-delta', index: 0, text: 'x' },
    })
    expect(Reflect.get(third.app, 'failed')).toBe(true)
  })

  it('resets a replacement stream, accepts chunk and end progress, and updates status', async () => {
    const session = childSession()
    const { app } = await bootHistory(session.header, [])
    Reflect.set(app, 'streamRevision', 9)
    const start = { type: 'start', attemptId: 'a', revision: 1, startedAfterSeq: 0, turn: 1, step: 1 }
    invoke(app, 'onAssistant', start)
    invoke(app, 'onAssistant', {
      type: 'chunk', attemptId: 'a', revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: 'x' },
    })
    invoke(app, 'onAssistant', {
      type: 'end', attemptId: 'a', revision: 3, index: 1, outcome: { kind: 'abandoned' },
    })
    invoke(app, 'onStatus', 'running')
    invoke(app, 'onExecutionEnd')
    expect(Reflect.get(app, 'execution')).toBe('idle')
  })

  it('reports assistant end and revision mismatches', async () => {
    const session = childSession()
    const first = await bootHistory(session.header, [])
    invoke(first.app, 'onAssistant', { type: 'start', attemptId: 'a', revision: 1, startedAfterSeq: 0, turn: 1, step: 1 })
    invoke(first.app, 'onAssistant', { type: 'end', attemptId: 'a', revision: 2, index: 3, outcome: { kind: 'abandoned' } })
    expect(Reflect.get(first.app, 'failed')).toBe(true)

    const second = await bootHistory(session.header, [])
    invoke(second.app, 'onAssistant', { type: 'start', attemptId: 'a', revision: 5, startedAfterSeq: 0, turn: 1, step: 1 })
    expect(Reflect.get(second.app, 'failed')).toBe(true)
  })

  it('applies a valid first event and the next contiguous event', async () => {
    const session = childSession()
    const { app } = await bootHistory(session.header, [])
    invoke(app, 'onEvent', turnStart(0))
    invoke(app, 'onEvent', turnStart(1))
    expect(Reflect.get(app, 'cursor')).toBe(1)
  })

  it('reports an event gap after the first event and a protocol failure after disconnect', async () => {
    const session = childSession()
    const { app } = await bootHistory(session.header, [])
    invoke(app, 'onEvent', turnStart(0))
    invoke(app, 'onEvent', turnStart(2))
    expect(Reflect.get(app, 'failed')).toBe(true)
    invoke(app, 'protocolFailure', 'late failure')
    expect(Reflect.get(app, 'failed')).toBe(true)
  })

  it('renders a history cut carrying a tool call through the read-only presenter', async () => {
    const session = childSession()
    const { app } = await bootHistory(session.header, [
      turnStart(0),
      { seq: 1, type: 'tool/call', time: 1, data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{}' } } as SessionEvent,
    ])
    expect(Reflect.get(app, 'cursor')).toBe(1)
  })

  it('shows the child approval audit in the read-only viewer', async () => {
    const session = childSession()
    const approvalId = ApprovalRequestId('approval-1')
    const { app } = await bootHistory(session.header, [
      turnStart(0),
      {
        seq: 1,
        type: 'approval/asked',
        time: 1,
        data: { id: approvalId, toolName: 'bash', reason: 'needs access' },
      } as SessionEvent,
      {
        seq: 2,
        type: 'approval/decided',
        time: 2,
        data: { id: approvalId, outcome: 'rejected' },
      } as SessionEvent,
    ])
    const transcript = Reflect.get(app, 'transcript') as { entries(): readonly unknown[] }
    expect(transcript.entries().at(-1)).toMatchObject({
      kind: 'approval',
      toolName: 'bash',
      outcome: 'rejected',
    })
  })

  it('ignores later updates after a failure and after teardown', async () => {
    const session = childSession()
    const { app } = await bootHistory(session.header, [])
    invoke(app, 'disconnect', 'gone')
    invoke(app, 'disconnect', 'again')
    invoke(app, 'onEvent', turnStart(0))
    invoke(app, 'onAssistant', { type: 'start', attemptId: 'a', revision: 1, startedAfterSeq: 0, turn: 1, step: 1 })
    invoke(app, 'teardown')
    invoke(app, 'refresh')
  })
})
