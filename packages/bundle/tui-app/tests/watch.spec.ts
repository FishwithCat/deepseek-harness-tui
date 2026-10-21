/**
 * Local subagent watching: record publication, authenticated NDJSON streaming,
 * continuity checks, history fallback, and the read-only viewer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-query'
import { LlmAttemptId, ToolCallId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as SessionStatsPlugin from '@deepseek-ai/dsh-session-stats'
import { visibleWidth } from '@earendil-works/pi-tui'
import { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { internals } from '../src/app.ts'
import { createTheme } from '../src/ansi.ts'
import {
  agentAssistantFrame,
  isLoopbackWatchAddress,
  parseWatchConnectionRecord,
  WATCH_PROTOCOL_HEADER,
  WATCH_PROTOCOL_VERSION,
  WATCH_STREAM_PATH,
  WATCH_TOKEN_HEADER,
  wireAssistantFrame,
} from '../src/watch/protocol.ts'
import { publishWatchRecord, readWatchRecord, removeOwnedWatchRecord, watchRecordPath } from '../src/watch/record.ts'
import { SubagentWatchHub, WATCH_HEARTBEAT_MS } from '../src/watch/server.ts'
import { WatchStreamError, openWatchStream, parseServerFrame } from '../src/watch/client.ts'
import { readWatchHistory } from '../src/watch/history.ts'
import { WatchApp, WatchStatusBar } from '../src/watch/viewer.ts'
import { FakeTerminal } from './support/fake-terminal.ts'

const originalInternals = { ...internals }
const contexts: Context[] = []
const homes: string[] = []

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-watch-'))
  homes.push(home)
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  Object.assign(internals, originalInternals)
  vi.unstubAllEnvs()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

/** A detached child session in the root's tree. */
function childSession(rootId: SessionId, childId: string): Session {
  const id = SessionId(childId)
  return Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    parentSession: rootId,
    isSeeded: false,
    origin: 'subagent',
    delegationDepth: 1,
  })
}

/** A context with a minimal agents lookup for the hub. */
function hubContext(session: Session): {
  ctx: Context
  agent: Agent
  history: SessionEvent[]
  setStatus: (value: 'idle' | 'running') => void
} {
  const ctx = new Context()
  contexts.push(ctx)
  let status: 'idle' | 'running' = 'idle'
  const agent = { id: session.id, session, options: {}, get status() { return status } } as Agent
  const history: SessionEvent[] = []
  ctx.provide('agents', { get: (id: SessionId) => id === session.id ? agent : undefined } as never)
  ctx.provide('sessionQuery', {
    async observeSession() {
      return {
        header: session.header,
        events: [...history],
        cursor: history.at(-1)?.seq ?? -1,
        [Symbol.dispose]() {},
      }
    },
  } as never)
  return { ctx, agent, history, setStatus: (value) => { status = value } }
}

/** Resolve the next NDJSON frame from a streaming response. */
async function readFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { buffer: string; decoder: TextDecoder },
): Promise<Record<string, unknown>> {
  for (;;) {
    const newline = state.buffer.indexOf('\n')
    if (newline !== -1) {
      const line = state.buffer.slice(0, newline)
      state.buffer = state.buffer.slice(newline + 1)
      return JSON.parse(line) as Record<string, unknown>
    }
    const chunk = await reader.read()
    if (chunk.done) throw new Error('stream ended')
    state.buffer += state.decoder.decode(chunk.value, { stream: true })
  }
}

/** Wait for a hub publication hook. */
function published(hub: SubagentWatchHub, ctx: Context, session: Session, rootId: SessionId): Promise<string> {
  return new Promise((resolve, reject) => {
    hub.activate(rootId, {
      published: (_id, command) => { resolve(command) },
      failed: (_id, error) => { reject(error instanceof Error ? error : new Error(String(error))) },
    })
    ctx.emit('subagent/start', {
      runId: SubagentRunId('run-1'),
      provider: 'spawn',
      id: session.id,
      local: true,
    })
  })
}

describe('watch protocol and records', () => {
  it('round-trips an assistant frame and validates loopback addresses', () => {
    const attemptId = LlmAttemptId('a1')
    expect(wireAssistantFrame({ type: 'start', attemptId, revision: 1, turn: 1, step: 2 }, 4))
      .toEqual({ type: 'start', attemptId, revision: 1, turn: 1, step: 2, startedAfterSeq: 4 })
    const frame = agentAssistantFrame({
      type: 'chunk', attemptId, revision: 2, index: 0, time: 1,
      chunk: { type: 'text-delta', index: 0, text: 'hi' },
    })
    expect(frame.type).toBe('chunk')
    expect(isLoopbackWatchAddress('http://127.0.0.1:1234')).toBe(true)
    expect(isLoopbackWatchAddress('http://localhost:1234')).toBe(false)
    expect(isLoopbackWatchAddress('https://127.0.0.1:1234')).toBe(false)
    expect(isLoopbackWatchAddress('http://127.0.0.1:1234/path')).toBe(false)
    expect(isLoopbackWatchAddress('http://user@127.0.0.1:1234')).toBe(false)
    expect(isLoopbackWatchAddress('http://127.0.0.1:1234?x=1')).toBe(false)
    expect(isLoopbackWatchAddress('http://127.0.0.1:1234#fragment')).toBe(false)
    expect(isLoopbackWatchAddress('not a url')).toBe(false)
    expect(agentAssistantFrame({
      type: 'start', attemptId, revision: 1, startedAfterSeq: 0, turn: 1, step: 1,
    })).toEqual({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 })
    expect(agentAssistantFrame({
      type: 'end', attemptId, revision: 3, index: 2, outcome: { kind: 'abandoned' },
    })).toEqual({ type: 'end', attemptId, revision: 3, index: 2, outcome: { kind: 'abandoned' } })
    expect(agentAssistantFrame({
      type: 'end', attemptId, revision: 4, index: 3,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 7 },
    })).toMatchObject({ outcome: { kind: 'committed', seq: 7 } })
  })

  it('publishes and removes an owner-only record atomically', async () => {
    const sessionId = SessionId('session-child')
    await publishWatchRecord({
      protocol: WATCH_PROTOCOL_VERSION,
      serviceInstanceId: 'instance-1',
      sessionId,
      rootSessionId: SessionId('session-root'),
      address: 'http://127.0.0.1:1234',
      token: 'secret',
    })
    const record = await readWatchRecord(sessionId)
    expect(record?.token).toBe('secret')
    await removeOwnedWatchRecord(sessionId, 'other-instance')
    expect(await readWatchRecord(sessionId)).toBeDefined()
    await removeOwnedWatchRecord(sessionId, 'instance-1')
    expect(await readWatchRecord(sessionId)).toBeUndefined()
    await expect(access(watchRecordPath(sessionId))).rejects.toThrow()
  })

  it('reports corrupt and incompatible records instead of treating them as absent', async () => {
    const sessionId = SessionId('session-child')
    await publishWatchRecord({
      protocol: WATCH_PROTOCOL_VERSION,
      serviceInstanceId: 'instance-1',
      sessionId,
      rootSessionId: SessionId('session-root'),
      address: 'http://127.0.0.1:1234',
      token: 'secret',
    })
    await writeFile(watchRecordPath(sessionId), '{not json', 'utf8')
    await expect(readWatchRecord(sessionId)).rejects.toThrow('not valid JSON')
    await writeFile(watchRecordPath(sessionId), JSON.stringify({
      protocol: 99,
      serviceInstanceId: 'instance-1',
      sessionId,
      rootSessionId: 'session-root',
      address: 'http://127.0.0.1:1234',
      token: 'secret',
    }), 'utf8')
    await expect(readWatchRecord(sessionId)).rejects.toThrow('protocol 99')
  })

  it('reports unreadable record paths and mismatched ids instead of treating them as absent', async () => {
    const sessionId = SessionId('session-child')
    await mkdir(watchRecordPath(sessionId), { recursive: true })
    await expect(readWatchRecord(sessionId)).rejects.toThrow()
    await rm(watchRecordPath(sessionId), { recursive: true, force: true })

    await writeFile(watchRecordPath(sessionId), JSON.stringify({
      protocol: WATCH_PROTOCOL_VERSION,
      serviceInstanceId: 'instance-1',
      sessionId: 'other-session',
      rootSessionId: 'session-root',
      address: 'http://127.0.0.1:1234',
      token: 'secret',
    }), 'utf8')
    await expect(readWatchRecord(sessionId)).rejects.toThrow('names "other-session"')

    await writeFile(watchRecordPath(sessionId), '{not json', 'utf8')
    await expect(removeOwnedWatchRecord(sessionId, 'instance-1')).resolves.toBeUndefined()

    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => { throw 'bad json' })
    try {
      await expect(readWatchRecord(sessionId)).rejects.toThrow('not valid JSON: bad json')
    } finally {
      parse.mockRestore()
    }
  })

  it('removes a temporary record when the final rename fails', async () => {
    const sessionId = SessionId('session-child')
    await mkdir(watchRecordPath(sessionId), { recursive: true })
    await expect(publishWatchRecord({
      protocol: WATCH_PROTOCOL_VERSION,
      serviceInstanceId: 'instance-1',
      sessionId,
      rootSessionId: SessionId('session-root'),
      address: 'http://127.0.0.1:1234',
      token: 'secret',
    })).rejects.toThrow()
    await rm(watchRecordPath(sessionId), { recursive: true, force: true })
  })

  it('rejects malformed and non-loopback records', () => {
    expect(() => parseWatchConnectionRecord(undefined)).toThrow('not a JSON object')
    expect(() => parseWatchConnectionRecord({ protocol: WATCH_PROTOCOL_VERSION })).toThrow('no valid serviceInstanceId')
    expect(() => parseWatchConnectionRecord({
      protocol: WATCH_PROTOCOL_VERSION,
      serviceInstanceId: 'i',
      sessionId: 's',
      rootSessionId: 'r',
      address: 'http://example.com:1',
      token: 't',
    })).toThrow('non-loopback')
  })
})

describe('subagent watch service', () => {
  it('streams a snapshot and later events and frames on an authenticated loopback request', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId, 'session-child')
    const { ctx, agent, history, setStatus } = hubContext(child)
    const hub = new SubagentWatchHub(ctx)
    const command = await published(hub, ctx, child, rootId)
    expect(command).toBe('dsh watch session-child')

    const record = await readWatchRecord('session-child')
    expect(record).toBeDefined()
    const response = await fetch(
      `${record!.address}${WATCH_STREAM_PATH}?session=session-child`,
      { headers: {
        [WATCH_PROTOCOL_HEADER]: String(WATCH_PROTOCOL_VERSION),
        [WATCH_TOKEN_HEADER]: record!.token,
      } },
    )
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const state = { buffer: '', decoder: new TextDecoder() }
    const snapshot = await readFrame(reader, state)
    expect(snapshot.type).toBe('snapshot')
    expect(snapshot.cursor).toBe(-1)

    const event = child.append('turn/start', { turn: 1 })
    history.push(event)
    ctx.emit('session/event', child, event)
    expect(await readFrame(reader, state)).toMatchObject({ type: 'event', event: { type: 'turn/start', seq: 0 } })

    const attemptId = LlmAttemptId('attempt-1')
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'start', attemptId, revision: 1, turn: 1, step: 1 },
    })
    expect(await readFrame(reader, state)).toMatchObject({
      type: 'assistant',
      frame: { type: 'start', revision: 1, startedAfterSeq: 0 },
    })
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', attemptId, revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'hello' } },
    })
    expect(await readFrame(reader, state)).toMatchObject({
      type: 'assistant',
      frame: { type: 'chunk', revision: 2, index: 0 },
    })

    setStatus('running')
    ctx.emit('agent/status', { agent, status: 'running' })
    expect(await readFrame(reader, state)).toMatchObject({ type: 'status', status: 'running' })

    ctx.emit('subagent/end', {
      runId: SubagentRunId('run-1'),
      provider: 'spawn',
      id: child.id,
      local: true,
      stopReason: 'completed',
    })
    expect(await readFrame(reader, state)).toMatchObject({ type: 'execution-end', stopReason: 'completed' })

    await reader.cancel()
    await hub.close()
    expect(await readWatchRecord('session-child')).toBeUndefined()
  })

  it('keeps a quiet stream alive with heartbeats', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId, 'session-child')
    const { ctx } = hubContext(child)
    const hub = new SubagentWatchHub(ctx)
    await published(hub, ctx, child, rootId)
    const record = await readWatchRecord('session-child')
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const response = await fetch(
        `${record!.address}${WATCH_STREAM_PATH}?session=session-child`,
        { headers: { [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: record!.token } },
      )
      const reader = response.body!.getReader()
      const state = { buffer: '', decoder: new TextDecoder() }
      expect((await readFrame(reader, state)).type).toBe('snapshot')
      vi.advanceTimersByTime(WATCH_HEARTBEAT_MS)
      expect(await readFrame(reader, state)).toEqual({ type: 'heartbeat' })
      await reader.cancel()
    } finally {
      vi.useRealTimers()
    }
    await hub.close()
  })

  it('publishes nested subagents that descend from a tracked child', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId, 'session-child')
    const grandchild = Session.create(SessionId('session-grandchild'), undefined, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('session-grandchild'),
      createdAt: Date.now() + 1,
      parentSession: child.id,
      isSeeded: false,
      origin: 'subagent',
      delegationDepth: 2,
    })
    const ctx = new Context()
    contexts.push(ctx)
    const agents = new Map<SessionId, Agent>([
      [child.id, { id: child.id, session: child, options: {}, status: 'idle' } as Agent],
      [grandchild.id, { id: grandchild.id, session: grandchild, options: {}, status: 'idle' } as Agent],
    ])
    const histories = new Map<SessionId, Session>([[child.id, child], [grandchild.id, grandchild]])
    ctx.provide('agents', { get: (id: SessionId) => agents.get(id) } as never)
    ctx.provide('sessionQuery', {
      async observeSession(id: SessionId) {
        const session = histories.get(id) as Session
        return { header: session.header, events: [], cursor: -1, [Symbol.dispose]() {} }
      },
    } as never)
    const publishedCommands: string[] = []
    const hub = new SubagentWatchHub(ctx)
    hub.activate(rootId, {
      published: (_id, command) => { publishedCommands.push(command) },
      failed: (_id, error) => { throw error },
    })
    ctx.emit('subagent/start', { runId: SubagentRunId('run-1'), provider: 'spawn', id: child.id, local: true })
    await vi.waitFor(() => { expect(publishedCommands).toHaveLength(1) })
    ctx.emit('subagent/start', { runId: SubagentRunId('run-2'), provider: 'spawn', id: grandchild.id, local: true })
    await vi.waitFor(() => { expect(publishedCommands).toHaveLength(2) })
    expect(publishedCommands).toEqual([
      'dsh watch session-child',
      'dsh watch session-grandchild',
    ])
    await hub.close()
  })

  it('settles viewers and removes records when the root tree is replaced', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId, 'session-child')
    const { ctx } = hubContext(child)
    const hub = new SubagentWatchHub(ctx)
    await published(hub, ctx, child, rootId)
    const record = await readWatchRecord('session-child')
    const response = await fetch(
      `${record!.address}${WATCH_STREAM_PATH}?session=session-child`,
      { headers: { [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: record!.token } },
    )
    const reader = response.body!.getReader()
    const state = { buffer: '', decoder: new TextDecoder() }
    expect((await readFrame(reader, state)).type).toBe('snapshot')

    await hub.rebind(SessionId('replacement-root'))

    expect(await readFrame(reader, state)).toEqual({ type: 'service-closed' })
    expect(await readWatchRecord('session-child')).toBeUndefined()
    await reader.cancel()
    await hub.close()
  })

  it('rejects a bad token, protocol, and unknown session without exposing the record', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId, 'session-child')
    const { ctx } = hubContext(child)
    const hub = new SubagentWatchHub(ctx)
    await published(hub, ctx, child, rootId)
    const record = await readWatchRecord('session-child')
    const url = `${record!.address}${WATCH_STREAM_PATH}?session=session-child`

    const unauthorized = await fetch(url, {
      headers: { [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: 'wrong' },
    })
    expect(unauthorized.status).toBe(401)

    const incompatible = await fetch(url, {
      headers: { [WATCH_PROTOCOL_HEADER]: '99', [WATCH_TOKEN_HEADER]: record!.token },
    })
    expect(incompatible.status).toBe(426)

    const unknown = await fetch(`${record!.address}${WATCH_STREAM_PATH}?session=other`, {
      headers: { [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: record!.token },
    })
    expect(unknown.status).toBe(404)

    const missing = await fetch(`${record!.address}${WATCH_STREAM_PATH}`, {
      headers: { [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: record!.token },
    })
    expect(missing.status).toBe(400)

    const wrongPath = await fetch(`${record!.address}/v1/other?session=session-child`, {
      headers: { [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: record!.token },
    })
    expect(wrongPath.status).toBe(404)

    const wrongMethod = await fetch(url, {
      method: 'POST',
      headers: { [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: record!.token },
    })
    expect(wrongMethod.status).toBe(405)
    await hub.close()
  })
})

describe('watch client and viewer', () => {
  it('applies the snapshot before events and assistant deltas in the same network read', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId, 'session-child')
    const initial = child.append('turn/start', { turn: 1 })
    const nextEvent = child.append('step/start', { turn: 1, step: 1 })
    await publishWatchRecord({
      protocol: WATCH_PROTOCOL_VERSION, serviceInstanceId: 'instance-1',
      sessionId: child.id, rootSessionId: rootId, address: 'http://127.0.0.1:1234', token: 'test-token',
    })
    const frames = [
      {
        type: 'snapshot', serviceInstanceId: 'instance-1', header: child.header,
        cursor: initial.seq, events: [initial], status: 'running',
        assistantStream: {
          revision: 2,
          activeAttempt: {
            attemptId: 'attempt-1', startedAfterSeq: initial.seq, turn: 1, step: 1, nextIndex: 1,
            stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [], texts: ['hello'] }],
          },
        },
      },
      { type: 'event', event: nextEvent },
      {
        type: 'assistant',
        frame: {
          type: 'chunk', attemptId: 'attempt-1', revision: 3, index: 1, time: 1,
          chunk: { type: 'text-delta', index: 0, text: ' world' },
        },
      },
    ]
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      expect(input).toEqual(new URL('http://127.0.0.1:1234/v1/stream?session=session-child'))
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n'))
          options?.signal?.addEventListener('abort', () => { controller.close() }, { once: true })
        },
      }))
    })
    const ctx = new Context()
    contexts.push(ctx)
    internals.isInteractive = () => true
    internals.createTerminal = () => new FakeTerminal()
    let app: WatchApp | undefined
    try {
      app = await WatchApp.boot({
        ctx, config: { screen: 'inline', colorScheme: 'auto' }, watch: child.id, exit: vi.fn(),
      })
      expect(Reflect.get(app, 'connection')).toBe('online')
      expect(Reflect.get(app, 'failed')).toBe(false)
      expect(Reflect.get(app, 'cursor')).toBe(nextEvent.seq)
      const transcript = Reflect.get(app, 'transcript') as { entries(): readonly { kind: string; text?: string }[] }
      expect(transcript.entries()).toContainEqual(expect.objectContaining({ kind: 'assistant', text: 'hello world' }))
    } finally {
      app?.stop(0)
      fetchMock.mockRestore()
    }
  })

  const streamChunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hello' },
    { type: 'reasoning-delta', index: 0, text: 'thinking' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId('call-1'), argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
    { type: 'usage', usage: { inputTokens: 12, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] satisfies StreamChunk[]

  it.each(streamChunks)('accepts a $type chunk', (chunk) => {
    const frame = {
      type: 'assistant',
      frame: { type: 'chunk', attemptId: 'attempt-1', revision: 2, index: 0, time: 1, chunk },
    }
    expect(parseServerFrame(JSON.stringify(frame))).toEqual(frame)
  })

  it.each(streamChunks.filter(chunk => 'index' in chunk))('rejects a $type chunk without a block index', (chunk) => {
    expect(() => parseServerFrame(JSON.stringify({
      type: 'assistant',
      frame: {
        type: 'chunk', attemptId: 'attempt-1', revision: 2, index: 0, time: 1,
        chunk: { ...chunk, index: undefined },
      },
    }))).toThrow(WatchStreamError)
  })

  it('accepts usage and finish records in an opening snapshot', () => {
    const frame = {
      type: 'snapshot',
      serviceInstanceId: 'instance-1',
      header: childSession(SessionId('session-root'), 'session-child').header,
      cursor: -1,
      events: [],
      status: 'running',
      assistantStream: {
        revision: 3,
        activeAttempt: {
          attemptId: 'attempt-1', startedAfterSeq: -1, turn: 1, step: 1, nextIndex: 2,
          stream: streamChunks.filter(chunk => chunk.type === 'usage' || chunk.type === 'finish')
            .map((chunk, time) => ({ type: 'chunk', time, chunk })),
        },
      },
    }
    expect(parseServerFrame(JSON.stringify(frame))).toEqual(frame)
  })

  it('cuts held assistant frames by arrival when a replacement resets revisions', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId, 'session-child')
    const ctx = new Context()
    contexts.push(ctx)
    let releaseObserve: () => void = () => {}
    const observeGate = new Promise<void>((resolve) => { releaseObserve = resolve })
    let observeStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => { observeStarted = resolve })
    const agent = { id: child.id, session: child, options: {}, status: 'idle' } as Agent
    ctx.provide('agents', { get: (id: SessionId) => id === child.id ? agent : undefined } as never)
    ctx.provide('sessionQuery', {
      async observeSession() {
        observeStarted()
        await observeGate
        return { header: child.header, events: [], cursor: -1, [Symbol.dispose]() {} }
      },
    } as never)
    const hub = new SubagentWatchHub(ctx)
    await published(hub, ctx, child, rootId)

    const first = LlmAttemptId('attempt-first')
    ctx.emit('agent/assistant-stream', {
      agent, frame: { type: 'start', attemptId: first, revision: 1, turn: 1, step: 1 },
    })
    for (let revision = 2; revision <= 42; revision += 1) {
      ctx.emit('agent/assistant-stream', {
        agent,
        frame: {
          type: 'chunk', attemptId: first, revision, index: revision - 2, time: revision,
          chunk: { type: 'text-delta', index: 0, text: 'old' },
        },
      })
    }

    const record = await readWatchRecord(child.id)
    const responsePromise = fetch(
      `${record!.address}${WATCH_STREAM_PATH}?session=${child.id}`,
      { headers: { [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: record!.token } },
    )
    await started

    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'end', attemptId: first, revision: 43, index: 41,
        outcome: { kind: 'abandoned' },
      },
    })
    const second = LlmAttemptId('attempt-second')
    ctx.emit('agent/assistant-stream', {
      agent, frame: { type: 'start', attemptId: second, revision: 1, turn: 2, step: 1 },
    })
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'chunk', attemptId: second, revision: 2, index: 0, time: 1,
        chunk: { type: 'text-delta', index: 0, text: 'new' },
      },
    })
    releaseObserve()
    const response = await responsePromise
    const reader = response.body!.getReader()
    const state = { buffer: '', decoder: new TextDecoder() }

    const snapshot = await readFrame(reader, state)
    expect(snapshot).toMatchObject({ type: 'snapshot', assistantStream: { revision: 2 } })
    expect(snapshot.assistantStream).toMatchObject({ activeAttempt: { attemptId: String(second) } })

    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'chunk', attemptId: second, revision: 3, index: 1, time: 2,
        chunk: { type: 'text-delta', index: 0, text: ' live' },
      },
    })
    expect(await readFrame(reader, state)).toMatchObject({ type: 'assistant', frame: { revision: 3, index: 1 } })
    await reader.cancel()
    await hub.close()
  })

  it('keeps a pre-snapshot service error instead of reporting a protocol failure', async () => {
    const record = {
      protocol: WATCH_PROTOCOL_VERSION,
      serviceInstanceId: 'instance-1',
      sessionId: SessionId('session-child'),
      rootSessionId: SessionId('session-root'),
      address: 'http://127.0.0.1:1234',
      token: 'test-token',
    } as const
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      `${JSON.stringify({ type: 'error', message: 'the stored log could not be read' })}\n`,
    ))
    try {
      await expect(openWatchStream(record, 'session-child', {
        onSnapshot: vi.fn(),
        onEvent: vi.fn(),
        onAssistant: vi.fn(),
        onStatus: vi.fn(),
        onExecutionEnd: vi.fn(),
        onServiceClosed: vi.fn(),
        onFailure: vi.fn(),
      })).rejects.toMatchObject({
        kind: 'service',
        message: 'the stored log could not be read',
      })
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('rejects visible event payloads before the transcript reads them', () => {
    const header = childSession(SessionId('session-root'), 'session-child').header
    const snapshot = (event: unknown): string => JSON.stringify({
      type: 'snapshot',
      serviceInstanceId: 'instance-1',
      header,
      cursor: 0,
      events: [event],
      status: 'idle',
      assistantStream: { revision: 0 },
    })
    expect(() => parseServerFrame(snapshot({ seq: 0, type: 'user/message', time: 0, data: {} })))
      .toThrow('malformed event')
    expect(() => parseServerFrame(snapshot({
      seq: 0, type: 'assistant/message', time: 0, data: { message: { role: 'assistant', content: [] } },
    }))).toThrow('malformed event')
    expect(() => parseServerFrame(JSON.stringify({
      type: 'event',
      event: { seq: 0, type: 'tool/call', time: 0, data: { callId: 'call-1' } },
    }))).toThrow('malformed event')
  })

  it('classifies a transcript fold failure as a protocol failure', async () => {
    const snapshot = {
      type: 'snapshot',
      serviceInstanceId: 'instance-1',
      header: childSession(SessionId('session-root'), 'session-child').header,
      cursor: 0,
      events: [{ seq: 0, type: 'turn/start', time: 0, data: { turn: 1 } }],
      status: 'idle',
      assistantStream: { revision: 0 },
    }
    const event = { seq: 1, type: 'turn/end', time: 1, data: { turn: 1, reason: { kind: 'completed' } } }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      `${JSON.stringify(snapshot)}\n${JSON.stringify({ type: 'event', event })}\n`,
    ))
    const failure = new Promise<WatchStreamError>((resolve) => {
      void openWatchStream({
        protocol: WATCH_PROTOCOL_VERSION,
        serviceInstanceId: 'instance-1',
        sessionId: SessionId('session-child'),
        rootSessionId: SessionId('session-root'),
        address: 'http://127.0.0.1:1234',
        token: 'test-token',
      }, 'session-child', {
        onSnapshot: vi.fn(),
        onEvent: () => { throw new Error('fold failed') },
        onAssistant: vi.fn(),
        onStatus: vi.fn(),
        onExecutionEnd: vi.fn(),
        onServiceClosed: vi.fn(),
        onFailure: (error) => { resolve(error) },
      }).catch(() => {})
    })
    try {
      await expect(failure).resolves.toMatchObject({
        kind: 'protocol',
        message: 'the watch viewer could not apply the frame: fold failed',
      })
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('keeps watching the next response after usage, finish, and message settlement', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId, 'session-child')
    const { ctx, agent, history } = hubContext(child)
    const hub = new SubagentWatchHub(ctx)
    const onAssistant = vi.fn()
    const onEvent = vi.fn()
    const onFailure = vi.fn()
    let stream: Awaited<ReturnType<typeof openWatchStream>> | undefined
    try {
      await published(hub, ctx, child, rootId)
      const record = await readWatchRecord(child.id)
      stream = await openWatchStream(record!, child.id, {
        onSnapshot: vi.fn(),
        onAssistant, onEvent, onFailure,
        onStatus: vi.fn(), onExecutionEnd: vi.fn(), onServiceClosed: vi.fn(),
      })
      const attemptId = LlmAttemptId('attempt-1')
      const chunks: StreamChunk[] = [
        { type: 'text-delta', index: 0, text: 'hello' },
        { type: 'usage', usage: { inputTokens: 12, outputTokens: 5 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      const frames: AssistantStreamFrame[] = [
        { type: 'start', attemptId, revision: 1, turn: 1, step: 1 },
        ...chunks.map((chunk, index) => ({
          type: 'chunk' as const, attemptId, revision: index + 2, index, time: index, chunk,
        })),
      ]
      for (const frame of frames) ctx.emit('agent/assistant-stream', { agent, frame })
      const event = child.append('assistant/message', {
        turn: 1, step: 1,
        stream: chunks.map((chunk, time) => ({ type: 'chunk', time, chunk })),
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'hello' }], source: { provider: 'p', model: 'm' },
        }),
      }, { surfaceOp: 'append' })
      history.push(event)
      ctx.emit('session/event', child, event)
      ctx.emit('agent/assistant-stream', {
        agent,
        frame: {
          type: 'end', attemptId, revision: 5, index: 3,
          outcome: { kind: 'committed', eventType: 'assistant/message', seq: event.seq },
        },
      })
      const nextAttempt = LlmAttemptId('attempt-2')
      ctx.emit('agent/assistant-stream', {
        agent, frame: { type: 'start', attemptId: nextAttempt, revision: 6, turn: 1, step: 2 },
      })
      ctx.emit('agent/assistant-stream', {
        agent,
        frame: {
          type: 'chunk', attemptId: nextAttempt, revision: 7, index: 0, time: 3,
          chunk: { type: 'text-delta', index: 0, text: 'next response' },
        },
      })
      await vi.waitFor(() => {
        expect(onFailure).not.toHaveBeenCalled()
        expect(onAssistant).toHaveBeenCalledWith(expect.objectContaining({ revision: 7 }))
      })
      expect(onEvent).toHaveBeenCalledWith(event)
      expect(onAssistant).toHaveBeenCalledTimes(7)
    } finally {
      stream?.close()
      await hub.close()
    }
  })

  it('parses frames and repairs a streamed assist attempt', async () => {
    expect(parseServerFrame(JSON.stringify({ type: 'status', status: 'idle' }))).toEqual({ type: 'status', status: 'idle' })
    expect(parseServerFrame(JSON.stringify({ type: 'heartbeat' }))).toEqual({ type: 'heartbeat' })
    expect(() => parseServerFrame('{')).toThrow(WatchStreamError)
    expect(() => parseServerFrame('{"type":"status","status":"busy"}')).toThrow('unknown execution state')

    const rootId = SessionId('session-root')
    const child = childSession(rootId, 'session-child')
    const { ctx, agent } = hubContext(child)
    const hub = new SubagentWatchHub(ctx)
    await published(hub, ctx, child, rootId)

    const attemptId = LlmAttemptId('attempt-1')
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'start', attemptId, revision: 1, turn: 1, step: 1 },
    })
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', attemptId, revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'streamed' } },
    })

    const terminal = new FakeTerminal()
    internals.isInteractive = () => true
    internals.createTerminal = () => terminal
    internals.copyClipboardText = async () => true
    const exits: number[] = []
    const app = await WatchApp.boot({
      ctx,
      config: { screen: 'inline', colorScheme: 'auto' },
      watch: 'session-child',
      exit: (code) => { exits.push(code) },
    })
    const transcript = Reflect.get(app, 'transcript') as { entries(): readonly { kind: string; text?: string }[] }
    expect(transcript.entries().some(entry => entry.kind === 'assistant' && entry.text === 'streamed')).toBe(true)

    ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', attemptId, revision: 3, index: 1, time: 2, chunk: { type: 'text-delta', index: 0, text: ' more' } },
    })
    await vi.waitFor(() => {
      expect(transcript.entries().some(entry => entry.kind === 'assistant' && entry.text === 'streamed more')).toBe(true)
    })

    ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', attemptId, revision: 5, index: 2, time: 3, chunk: { type: 'text-delta', index: 0, text: 'lost' } },
    })
    await vi.waitFor(() => {
      expect(transcript.entries().some(entry => entry.kind === 'notice')).toBe(true)
    })
    expect(transcript.entries().some(entry => entry.kind === 'assistant' && entry.text === 'streamed more')).toBe(true)

    terminal.feed('\u001b')
    await vi.waitFor(() => { expect(exits).toEqual([0]) })
    await hub.close()
  })

  it('falls back to stored history when no record exists', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const sessionId = SessionId('stored-child')
    const history: SessionEvent[] = []
    const source = Session.create(sessionId, undefined, {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: Date.now(),
      isSeeded: false,
      origin: 'subagent',
    })
    source.append('turn/start', { turn: 1 })
    source.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'stored prompt' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    history.push(...source.ownEvents())
    ctx.provide('sessionPersistence', {
      async open(id: SessionId) {
        if (id !== sessionId) throw new Error('not found')
        return {
          header: source.header,
          async read() { return { events: history, eventState: 'shared-frozen' } },
          close: () => Promise.resolve(),
        }
      },
    } as never)
    const terminal = new FakeTerminal()
    internals.isInteractive = () => true
    internals.createTerminal = () => terminal
    internals.copyClipboardText = async () => true
    const exits: number[] = []
    const app = await WatchApp.boot({
      ctx,
      config: { screen: 'alternate', colorScheme: 'dark' },
      watch: 'stored-child',
      exit: (code) => { exits.push(code) },
    })
    const transcript = Reflect.get(app, 'transcript') as { entries(): readonly { kind: string; id: number }[] }
    expect(transcript.entries().length).toBeGreaterThan(0)
    terminal.feed('\u0003')
    await vi.waitFor(() => { expect(exits).toEqual([0]) })
  })

  it('rejects a stored session that names a different id or is not a subagent', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const session = childSession(SessionId('session-root'), 'session-child')
    let header = { ...session.header, id: SessionId('other-child') }
    ctx.provide('sessionPersistence', {
      async open() {
        return {
          header,
          async read() { return { events: [], eventState: 'shared-frozen' } },
          close: () => Promise.resolve(),
        }
      },
    } as never)
    await expect(readWatchHistory(ctx, 'session-child')).rejects.toThrow('returned "other-child"')
    header = { ...session.header }
    delete header.origin
    await expect(readWatchHistory(ctx, 'session-child')).rejects.toThrow('is not a subagent session')
  })

  it('reports history read failures as diagnostics', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    internals.isInteractive = () => true
    internals.createTerminal = () => new FakeTerminal()
    await expect(WatchApp.boot({
      ctx,
      config: { screen: 'inline', colorScheme: 'auto' },
      watch: 'missing',
      exit: () => {},
    })).rejects.toThrow('stores no sessions')
    await expect(readWatchHistory(ctx, 'missing')).rejects.toThrow('stores no sessions')
  })

  it('renders the watch footer', () => {
    const bar = new WatchStatusBar(createTheme({ enabled: false, palette: 'dark' }))
    bar.set({ sessionId: 'session-child', connection: 'online', execution: 'running' })
    expect(bar.render(80)[0]).toContain('watch session-child')
    expect(bar.render(80)[0]).toContain('online')
    expect(bar.render(80)[0]).toContain('running')
    bar.set({ sessionId: 'session-child', connection: 'disconnected' })
    expect(bar.render(80)[0]).toContain('disconnected')
  })

  it.each(['online', 'history', 'seeded history'] as const)('shows committed child usage in %s mode', async (connection) => {
    const rootId = SessionId('usage-root')
    let child = childSession(rootId, 'usage-child')
    if (connection === 'seeded history') {
      const seed = Session.create(rootId)
      seed.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'inherited prompt' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      child = Session.create(child.id, seed.ownEvents(), { ...child.header, isSeeded: true }, seed.seq)
    }
    const { ctx, history } = hubContext(child)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SessionStatsPlugin)
    child.append('turn/start', { turn: 1 })
    child.append('step/start', { turn: 1, step: 1 })
    child.append('request/context', { provider: 'test', model: 'test', contextWindow: 1_000_000 })
    const appendUsage = (step: number): SessionEvent => child.append('assistant/message', {
      turn: 1, step, stream: [],
      usage: { inputTokens: 979, cacheReadTokens: 10_021, outputTokens: 24_000 },
      message: createAssistantMessage({ content: [{ type: 'text', text: 'done' }], source: { provider: 'test', model: 'test' } }),
    }, { surfaceOp: 'append' })
    appendUsage(1)
    history.push(...child.snapshotEvents())
    const hub = new SubagentWatchHub(ctx)
    const terminal = new FakeTerminal()
    internals.isInteractive = () => true
    internals.createTerminal = () => terminal
    if (connection === 'online') await published(hub, ctx, child, rootId)
    else ctx.provide('sessionPersistence', {
      async open() {
        return { header: child.header, async read() { return { events: history, eventState: 'shared-frozen' } }, close: async () => {} }
      },
    } as never)
    let app: WatchApp | undefined
    try {
      app = await WatchApp.boot({ ctx, config: { screen: 'alternate', colorScheme: 'dark' }, watch: child.id, exit: () => {} })
      const footer = Reflect.get(app, 'statusBar') as WatchStatusBar
      expect(footer.render(100)[1]?.trim()).toMatchInlineSnapshot(`
        "1.1%/1.0M                                                                       35k tok  91.1% cache"
      `)
      for (const width of [1, 12, 40, 100]) {
        expect(footer.render(width).every(line => visibleWidth(line) <= width)).toBe(true)
      }
      if (connection === 'online') {
        const event = appendUsage(2)
        history.push(event)
        ctx.emit('session/event', child, event)
        await vi.waitFor(() => { expect(footer.render(100)[1]).toContain('70k tok') })
        await hub.close()
        await vi.waitFor(() => { expect(footer.render(100)[0]).toContain('disconnected') })
        expect(footer.render(100)[1]).toContain('70k tok')
      }
    } finally {
      app?.stop(0)
      await hub.close()
    }
  })

  it('keeps the screen and reports a service that closes under a live viewer', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId, 'session-child')
    const { ctx } = hubContext(child)
    const hub = new SubagentWatchHub(ctx)
    await published(hub, ctx, child, rootId)
    const terminal = new FakeTerminal()
    internals.isInteractive = () => true
    internals.createTerminal = () => terminal
    internals.copyClipboardText = async () => true
    const exits: number[] = []
    const app = await WatchApp.boot({
      ctx,
      config: { screen: 'inline', colorScheme: 'auto' },
      watch: 'session-child',
      exit: (code) => { exits.push(code) },
    })
    await hub.close()
    await vi.waitFor(() => { expect(Reflect.get(app, 'connection')).toBe('disconnected') })
    const transcript = Reflect.get(app, 'transcript') as { entries(): readonly { kind: string }[] }
    expect(transcript.entries().some(entry => entry.kind === 'notice')).toBe(true)
    terminal.feed('\u001b')
    await vi.waitFor(() => { expect(exits).toEqual([0]) })
  })

  it('falls back to history when a published service is gone', async () => {
    await publishWatchRecord({
      protocol: WATCH_PROTOCOL_VERSION,
      serviceInstanceId: 'instance-1',
      sessionId: SessionId('session-child'),
      rootSessionId: SessionId('session-root'),
      address: 'http://127.0.0.1:1',
      token: 'secret',
    })
    const ctx = new Context()
    contexts.push(ctx)
    const sessionId = SessionId('session-child')
    const source = childSession(SessionId('session-root'), 'session-child')
    source.append('turn/start', { turn: 1 })
    ctx.provide('sessionPersistence', {
      async open() {
        return {
          header: source.header,
          async read() { return { events: source.ownEvents(), eventState: 'shared-frozen' } },
          close: () => Promise.resolve(),
        }
      },
    } as never)
    const terminal = new FakeTerminal()
    internals.isInteractive = () => true
    internals.createTerminal = () => terminal
    internals.copyClipboardText = async () => true
    const exits: number[] = []
    const app = await WatchApp.boot({
      ctx,
      config: { screen: 'inline', colorScheme: 'auto' },
      watch: 'session-child',
      exit: (code) => { exits.push(code) },
    })
    expect(Reflect.get(app, 'connection')).toBe('history')
    terminal.feed('\u0004')
    await vi.waitFor(() => { expect(exits).toEqual([0]) })
    expect(sessionId).toBe('session-child')
  })

  it('reports a missing history when a stale record has no stored log', async () => {
    await publishWatchRecord({
      protocol: WATCH_PROTOCOL_VERSION,
      serviceInstanceId: 'instance-1',
      sessionId: SessionId('session-child'),
      rootSessionId: SessionId('session-root'),
      address: 'http://127.0.0.1:1',
      token: 'secret',
    })
    const ctx = new Context()
    contexts.push(ctx)
    internals.isInteractive = () => true
    internals.createTerminal = () => new FakeTerminal()
    await expect(WatchApp.boot({
      ctx,
      config: { screen: 'inline', colorScheme: 'auto' },
      watch: 'session-child',
      exit: () => {},
    })).rejects.toThrow('could not read session')
  })
})
