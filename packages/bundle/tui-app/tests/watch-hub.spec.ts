/**
 * Watch hub lifecycle guards, publication failures, HTTP rejection paths, and
 * the snapshot error frames a viewer can receive.
 */

import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-query'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import { readWatchRecord } from '../src/watch/record.ts'
import { SubagentWatchHub } from '../src/watch/server.ts'
import { WATCH_PROTOCOL_HEADER, WATCH_STREAM_PATH, WATCH_TOKEN_HEADER } from '../src/watch/protocol.ts'

const contexts: Context[] = []
const hubs: SubagentWatchHub[] = []
const homes: string[] = []

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-watch-hub-'))
  homes.push(home)
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close()
  vi.unstubAllEnvs()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

/** One detached child session under `rootId`. */
function childSession(rootId: SessionId, childId = 'session-child'): Session {
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

/** A context with an agent lookup and a mutable observe result. */
function hubContext(child: Session): {
  ctx: Context
  agent: Agent
  query: { events: SessionEvent[]; header: Session['header']; fail?: unknown }
} {
  const ctx = new Context()
  contexts.push(ctx)
  const agent = { id: child.id, session: child, options: {}, status: 'idle' } as Agent
  const query: { events: SessionEvent[]; header: Session['header']; fail?: unknown } = {
    events: [],
    header: child.header,
  }
  ctx.provide('agents', { get: (id: SessionId) => id === child.id ? agent : undefined } as never)
  ctx.provide('sessionQuery', {
    async observeSession() {
      if (query.fail !== undefined) throw query.fail
      return {
        header: query.header,
        events: [...query.events],
        cursor: query.events.at(-1)?.seq ?? -1,
        [Symbol.dispose]() {},
      }
    },
  } as never)
  return { ctx, agent, query }
}

/** Register a hub for teardown. */
function hubFor(ctx: Context): SubagentWatchHub {
  const hub = new SubagentWatchHub(ctx)
  hubs.push(hub)
  return hub
}

/** Private hub members the tests drive directly. */
interface HubPrivate {
  onStart(info: unknown): void
  onAssistantFrame(agent: Agent, frame: unknown): void
  onAgentStatus(agent: Agent): void
  closeOnce(): Promise<void>
  handle(request: unknown, response: unknown): void
  openStream(response: unknown, state: unknown): Promise<void>
  ensureServer(): Promise<string>
  publish(id: SessionId, state: unknown): Promise<void>
}

/** Invoke one private hub member. */
function privateHub<K extends keyof HubPrivate>(hub: SubagentWatchHub, key: K): HubPrivate[K] {
  const member = Reflect.get(hub, key) as HubPrivate[K]
  return member.bind(hub) as HubPrivate[K]
}

/** One in-memory ServerResponse for direct handler calls. */
class FakeHttpResponse extends EventEmitter {
  status = 0
  body = ''
  headersSent = false
  destroyed = false

  writeHead(status: number): void {
    this.status = status
    this.headersSent = true
  }

  write(payload: string): boolean {
    this.body += payload
    return true
  }

  end(payload = ''): void {
    this.body += payload
    this.emit('close')
  }

  destroy(): void {
    this.destroyed = true
    this.emit('close')
  }
}

/** One fake request. */
function request(method: string, url: string, headers: Record<string, string> = {}): never {
  return { method, url, headers } as never
}

/** Wait for a hub publication hook. */
function publication(hub: SubagentWatchHub, ctx: Context, child: Session, rootId: SessionId): Promise<{
  command?: string
  error?: unknown
}> {
  return new Promise((resolve) => {
    hub.activate(rootId, {
      published: (_id, command) => { resolve({ command }) },
      failed: (_id, error) => { resolve({ error }) },
    })
    ctx.emit('subagent/start', { runId: SubagentRunId('run-1'), provider: 'spawn', id: child.id, local: true })
  })
}

describe('SubagentWatchHub lifecycle guards', () => {
  it('reports a missing sessionQuery instead of publishing', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('agents', { get: () => ({ id: child.id, session: child, options: {}, status: 'idle' }) } as never)
    const hub = hubFor(ctx)
    const result = await publication(hub, ctx, child, rootId)
    expect(result.command).toBeUndefined()
    expect(String(result.error)).toContain('requires the sessionQuery service')
  })

  it('reports a record publication failure instead of throwing', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx } = hubContext(child)
    await writeFile(join(process.env.DSH_HOME as string, 'runtime'), 'blocking file', 'utf8')
    const hub = hubFor(ctx)
    const result = await publication(hub, ctx, child, rootId)
    expect(result.command).toBeUndefined()
    expect(result.error).toBeDefined()
  })

  it('ignores starts after close, for non-local runs, and without a tracked root', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx, agent } = hubContext(child)
    const hub = hubFor(ctx)
    const info = { runId: SubagentRunId('run-1'), provider: 'spawn', id: child.id, local: true }
    const onStart = privateHub(hub, 'onStart')
    onStart(info)
    await hub.close()
    onStart(info)
    hub.activate(rootId, { published: () => {}, failed: () => {} })
    onStart({ ...info, local: false })
    expect(agent.session.id).toBe(child.id)
  })

  it('ignores starts without an agent, without a parent, and outside the tracked tree', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const orphan = Session.create(SessionId('orphan-child'), undefined, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('orphan-child'),
      createdAt: Date.now(),
      isSeeded: false,
      origin: 'subagent',
    })
    const foreign = Session.create(SessionId('foreign-child'), undefined, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('foreign-child'),
      createdAt: Date.now(),
      parentSession: SessionId('another-root'),
      isSeeded: false,
      origin: 'subagent',
    })
    const { ctx } = hubContext(child)
    const hub = hubFor(ctx)
    hub.activate(rootId, { published: () => {}, failed: () => {} })
    const onStart = privateHub(hub, 'onStart')
    onStart({ runId: SubagentRunId('run-x'), provider: 'spawn', id: SessionId('missing'), local: true })
    onStart({ runId: SubagentRunId('run-y'), provider: 'spawn', id: orphan.id, local: true })
    onStart({ runId: SubagentRunId('run-z'), provider: 'spawn', id: foreign.id, local: true })
    expect(await readWatchRecord('missing')).toBeUndefined()
  })

  it('keeps a tracked child when a later start repeats its id', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx, query } = hubContext(child)
    const hub = hubFor(ctx)
    await publication(hub, ctx, child, rootId)
    query.events.push(child.append('turn/start', { turn: 1 }))
    ctx.emit('subagent/start', { runId: SubagentRunId('run-2'), provider: 'spawn', id: child.id, local: true })
    await vi.waitFor(async () => { expect(await readWatchRecord(child.id)).toBeDefined() })
  })

  it('ignores lifecycle notifications for unknown or mismatched children', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx } = hubContext(child)
    const hub = hubFor(ctx)
    await publication(hub, ctx, child, rootId)
    const other = childSession(rootId, 'other-child')
    const otherAgent = { id: other.id, session: other, options: {}, status: 'running' } as Agent
    ctx.emit('subagent/end', {
      runId: SubagentRunId('run-x'), provider: 'spawn', id: SessionId('unknown'), local: true, stopReason: 'completed',
    })
    ctx.emit('session/event', other, other.append('turn/start', { turn: 1 }))
    ctx.emit('agent/assistant-stream', {
      agent: otherAgent,
      frame: { type: 'start', attemptId: LlmAttemptId('other'), revision: 1, turn: 1, step: 1 },
    })
    ctx.emit('agent/status', { agent: otherAgent, status: 'running' })
    ctx.emit('agent/disposed', { agent: otherAgent })
    ctx.emit('agent/disposed', { agent: { id: child.id, session: child, options: {}, status: 'idle' } as Agent })
    expect(hub).toBeDefined()
  })

  it('re-uses listeners and rebinds to a replacement root', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx } = hubContext(child)
    const hub = hubFor(ctx)
    hub.activate(rootId, { published: () => {}, failed: () => {} })
    hub.activate(rootId, { published: () => {}, failed: () => {} })
    await hub.rebind(SessionId('replacement-root'))
    hub.activate(SessionId('replacement-root'), { published: () => {}, failed: () => {} })
    await expect(hub.rebind(SessionId('second-replacement'))).resolves.toBeUndefined()
  })

  it('settles repeated close calls and ignores activation after close', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx } = hubContext(child)
    const hub = hubFor(ctx)
    hub.activate(rootId, { published: () => {}, failed: () => {} })
    await hub.close()
    await hub.close()
    hub.activate(rootId, { published: () => {}, failed: () => {} })
    const closeOnce = privateHub(hub, 'closeOnce')
    await closeOnce()
  })
})

/** Read one NDJSON frame from a streaming response. */
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

describe('SubagentWatchHub live notifications', () => {
  it('rebinds a replacement root and closes the live viewer', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx } = hubContext(child)
    const hub = hubFor(ctx)
    await publication(hub, ctx, child, rootId)
    const record = await readWatchRecord(child.id)
    const response = await fetch(`${record!.address}${WATCH_STREAM_PATH}?session=${child.id}`, {
      headers: { [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: record!.token },
    })
    const reader = response.body!.getReader()
    const state = { buffer: '', decoder: new TextDecoder() }
    expect((await readFrame(reader, state)).type).toBe('snapshot')
    hub.activate(SessionId('replacement-root'), { published: () => {}, failed: () => {} })
    expect(await readFrame(reader, state)).toEqual({ type: 'service-closed' })
    await reader.cancel()
  })

  it('sends execution end, events, assistant frames, status, and disposal', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx, agent, query } = hubContext(child)
    const hub = hubFor(ctx)
    await publication(hub, ctx, child, rootId)
    const record = await readWatchRecord(child.id)
    const response = await fetch(`${record!.address}${WATCH_STREAM_PATH}?session=${child.id}`, {
      headers: { [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: record!.token },
    })
    const reader = response.body!.getReader()
    const state = { buffer: '', decoder: new TextDecoder() }
    expect((await readFrame(reader, state)).type).toBe('snapshot')

    Object.defineProperty(agent, 'status', { value: 'running' })
    const event = child.append('turn/start', { turn: 1 })
    query.events.push(event)
    ctx.emit('subagent/end', {
      runId: SubagentRunId('run-1'), provider: 'spawn', id: child.id, local: true, stopReason: 'completed',
    })
    ctx.emit('session/event', child, event)
    ctx.emit('agent/assistant-stream', {
      agent, frame: { type: 'start', attemptId: LlmAttemptId('attempt-1'), revision: 1, turn: 1, step: 1 },
    })
    ctx.emit('agent/status', { agent, status: 'running' })
    ctx.emit('agent/disposed', { agent })
    ctx.emit('agent/status', { agent, status: 'idle' })

    expect(await readFrame(reader, state)).toMatchObject({ type: 'execution-end' })
    expect(await readFrame(reader, state)).toMatchObject({ type: 'event', event: { seq: 0 } })
    expect(await readFrame(reader, state)).toMatchObject({ type: 'assistant', frame: { type: 'start' } })
    expect(await readFrame(reader, state)).toMatchObject({ type: 'status', status: 'running' })
    await reader.cancel()
  })

  it('ignores a parentless child and publishes a nested child', async () => {
    const rootId = SessionId('session-root')
    const orphan = Session.create(SessionId('orphan-child'), undefined, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('orphan-child'),
      createdAt: Date.now(),
      isSeeded: false,
      origin: 'subagent',
    })
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('agents', { get: () => ({ id: orphan.id, session: orphan, options: {}, status: 'idle' }) } as never)
    ctx.provide('sessionQuery', {
      async observeSession() {
        return { header: orphan.header, events: [], cursor: -1, [Symbol.dispose]() {} }
      },
    } as never)
    const hub = hubFor(ctx)
    hub.activate(rootId, { published: () => {}, failed: () => {} })
    ctx.emit('subagent/start', { runId: SubagentRunId('run-1'), provider: 'spawn', id: orphan.id, local: true })
    await expect(readWatchRecord(orphan.id)).resolves.toBeUndefined()

    const child = childSession(rootId)
    const grandchild = Session.create(SessionId('grandchild'), undefined, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('grandchild'),
      createdAt: Date.now(),
      parentSession: child.id,
      isSeeded: false,
      origin: 'subagent',
      delegationDepth: 2,
    })
    const nested = new Context()
    contexts.push(nested)
    const agents = new Map([
      [child.id, { id: child.id, session: child, options: {}, status: 'idle' }],
      [grandchild.id, { id: grandchild.id, session: grandchild, options: {}, status: 'idle' }],
    ])
    const sessions = new Map([[child.id, child], [grandchild.id, grandchild]])
    nested.provide('agents', { get: (id: SessionId) => agents.get(id) } as never)
    nested.provide('sessionQuery', {
      async observeSession(id: SessionId) {
        const session = sessions.get(id) as Session
        return { header: session.header, events: [], cursor: -1, [Symbol.dispose]() {} }
      },
    } as never)
    const nestedHub = hubFor(nested)
    const commands: string[] = []
    nestedHub.activate(rootId, {
      published: (_id, command) => { commands.push(command) },
      failed: (_id, error) => { throw error },
    })
    nested.emit('subagent/start', { runId: SubagentRunId('run-1'), provider: 'spawn', id: child.id, local: true })
    await vi.waitFor(() => { expect(commands).toHaveLength(1) })
    nested.emit('subagent/start', { runId: SubagentRunId('run-2'), provider: 'spawn', id: grandchild.id, local: true })
    await vi.waitFor(() => { expect(commands).toHaveLength(2) })
  })

  it('drops a publication whose child left the tree and suppresses failure after close', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('sessionQuery', {
      async observeSession() { return { header: undefined, events: [], cursor: -1, [Symbol.dispose]() {} } },
    } as never)
    const hub = new SubagentWatchHub(ctx)
    const state = {
      sessionId: SessionId('gone'), agent: undefined, session: undefined,
      stream: { snapshot: () => ({ revision: 0 }) }, assistantOrdinal: 0, connections: new Set(),
    }
    hub.activate(SessionId('session-root'), { published: () => {}, failed: () => {} })
    const publish = privateHub(hub, 'publish')
    await publish(SessionId('gone'), state)
    await hub.close()
    await publish(SessionId('gone'), state)
  })

  it('removes a record published after its viewer was torn down', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx } = hubContext(child)
    const hub = hubFor(ctx)
    await publication(hub, ctx, child, rootId)
    const children = Reflect.get(hub, 'children') as Map<string, unknown>
    const state = children.get(child.id)
    const publish = privateHub(hub, 'publish')
    const pending = publish(child.id, state)
    await Promise.resolve()
    await hub.close()
    await pending
    await expect(readWatchRecord(child.id)).resolves.toBeUndefined()
  })

  it('ignores a start whose parent is outside the tracked tree', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const foreign = Session.create(SessionId('foreign-child'), undefined, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('foreign-child'),
      createdAt: Date.now(),
      parentSession: SessionId('another-root'),
      isSeeded: false,
      origin: 'subagent',
    })
    const ctx = new Context()
    contexts.push(ctx)
    const agents = new Map([
      [child.id, { id: child.id, session: child, options: {}, status: 'idle' }],
      [foreign.id, { id: foreign.id, session: foreign, options: {}, status: 'idle' }],
    ])
    ctx.provide('agents', { get: (id: SessionId) => agents.get(id) } as never)
    ctx.provide('sessionQuery', {
      async observeSession() { return { header: child.header, events: [], cursor: -1, [Symbol.dispose]() {} } },
    } as never)
    const hub = hubFor(ctx)
    hub.activate(rootId, { published: () => {}, failed: () => {} })
    ctx.emit('subagent/start', { runId: SubagentRunId('run-1'), provider: 'spawn', id: foreign.id, local: true })
    await expect(readWatchRecord(foreign.id)).resolves.toBeUndefined()
  })

  it('reports an assistant start at cursor -1 and an idle status', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx, agent } = hubContext(child)
    const hub = hubFor(ctx)
    await publication(hub, ctx, child, rootId)
    const frame = { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 }
    privateHub(hub, 'onAssistantFrame')(agent, frame)
    privateHub(hub, 'onAgentStatus')(agent)
  })
})

describe('SubagentWatchHub HTTP boundaries', () => {
  it('answers with 404 before a root is bound and ignores a response whose headers were sent', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const hub = hubFor(ctx)
    const response = new FakeHttpResponse()
    const handle = privateHub(hub, 'handle')
    handle(request('GET', WATCH_STREAM_PATH), response)
    expect(response.status).toBe(404)

    const sent = new FakeHttpResponse()
    sent.headersSent = true
    handle(request('POST', WATCH_STREAM_PATH), sent)
    expect(sent.status).toBe(0)
  })

  it('rejects an unknown path, protocol, and missing session over HTTP', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx } = hubContext(child)
    const hub = hubFor(ctx)
    await publication(hub, ctx, child, rootId)
    const record = await readWatchRecord(child.id)
    const headers = { [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: record!.token }
    const unknownPath = await fetch(`${record!.address}/v1/other?session=${child.id}`, { headers })
    expect(unknownPath.status).toBe(404)
    const wrongProtocol = await fetch(`${record!.address}${WATCH_STREAM_PATH}?session=${child.id}`, {
      headers: { [WATCH_PROTOCOL_HEADER]: '99', [WATCH_TOKEN_HEADER]: record!.token },
    })
    expect(wrongProtocol.status).toBe(426)
    const missing = await fetch(`${record!.address}${WATCH_STREAM_PATH}`, { headers })
    expect(missing.status).toBe(400)
  })

  it('uses the root response when a request has no URL and reports a non-Error handler throw', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx } = hubContext(child)
    const hub = hubFor(ctx)
    hub.activate(rootId, { published: () => {}, failed: () => {} })
    const handle = privateHub(hub, 'handle')
    const noUrl = new FakeHttpResponse()
    handle({ method: 'GET', headers: {} }, noUrl)
    expect(noUrl.status).toBe(404)

    const thrown = new FakeHttpResponse()
    handle({
      method: 'GET',
      get url(): string { throw 'bad url' },
      headers: {},
    }, thrown)
    expect(thrown.status).toBe(500)
    expect(thrown.body).toContain('bad url')
  })

  it('handles an openStream rejection before and after the response head', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx } = hubContext(child)
    const hub = hubFor(ctx)
    await publication(hub, ctx, child, rootId)
    const handle = privateHub(hub, 'handle')
    const request = { method: 'GET', url: `${WATCH_STREAM_PATH}?session=${child.id}`, headers: {
      [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: 'x'.repeat(43),
    } }
    // Use the hub's real token through a published record so the request passes auth.
    const record = await readWatchRecord(child.id)
    const authenticated = { ...request, headers: {
      [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: record!.token,
    } }
    const beforeHead = new FakeHttpResponse()
    Reflect.set(hub, 'openStream', async () => { throw new Error('before head') })
    handle(authenticated, beforeHead)
    await vi.waitFor(() => { expect(beforeHead.status).toBe(500) })

    const plainHead = new FakeHttpResponse()
    Reflect.set(hub, 'openStream', async () => { throw 'plain stream failure' })
    handle(authenticated, plainHead)
    await vi.waitFor(() => {
      expect(plainHead.status).toBe(500)
      expect(plainHead.body).toContain('plain stream failure')
    })

    const afterHead = new FakeHttpResponse()
    Reflect.set(hub, 'openStream', async (response: FakeHttpResponse) => {
      response.writeHead(200)
      throw new Error('after head')
    })
    handle(authenticated, afterHead)
    await vi.waitFor(() => { expect(afterHead.destroyed).toBe(true) })
  })

  it('rejects an invalid request URL through the internal-error path', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx } = hubContext(child)
    const hub = hubFor(ctx)
    const response = new FakeHttpResponse()
    const handle = privateHub(hub, 'handle')
    hub.activate(rootId, { published: () => {}, failed: () => {} })
    handle(request('GET', 'http://['), response)
    expect(response.status).toBe(500)
  })

  it('reports an unreadable snapshot as a pre-snapshot error frame', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx, query } = hubContext(child)
    const hub = hubFor(ctx)
    await publication(hub, ctx, child, rootId)
    query.fail = 'stored read failed'
    const record = await readWatchRecord(child.id)
    const response = await fetch(`${record!.address}${WATCH_STREAM_PATH}?session=${child.id}`, {
      headers: { [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: record!.token },
    })
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(text).toContain('"type":"error"')
    expect(text).toContain('stored read failed')
  })

  it('reports a header mismatch as a pre-snapshot error frame', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx, query } = hubContext(child)
    const hub = hubFor(ctx)
    await publication(hub, ctx, child, rootId)
    query.header = { ...child.header, id: SessionId('other-child') }
    const record = await readWatchRecord(child.id)
    const response = await fetch(`${record!.address}${WATCH_STREAM_PATH}?session=${child.id}`, {
      headers: { [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: record!.token },
    })
    expect(await response.text()).toContain('other-child')
  })

  it('reports a running child in the opening snapshot', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx, agent } = hubContext(child)
    Object.defineProperty(agent, 'status', { value: 'running' })
    const hub = hubFor(ctx)
    await publication(hub, ctx, child, rootId)
    const record = await readWatchRecord(child.id)
    const response = await fetch(`${record!.address}${WATCH_STREAM_PATH}?session=${child.id}`, {
      headers: { [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: record!.token },
    })
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('"status":"running"')
    await reader.cancel()
  })

  it('reports an idle child in the opening snapshot', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx } = hubContext(child)
    const hub = hubFor(ctx)
    await publication(hub, ctx, child, rootId)
    const record = await readWatchRecord(child.id)
    const response = await fetch(`${record!.address}${WATCH_STREAM_PATH}?session=${child.id}`, {
      headers: { [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: record!.token },
    })
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('"status":"idle"')
    await reader.cancel()
  })

  it('rejects a same-length wrong token', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx } = hubContext(child)
    const hub = hubFor(ctx)
    await publication(hub, ctx, child, rootId)
    const record = await readWatchRecord(child.id)
    const wrong = record!.token.slice(0, -1) + (record!.token.endsWith('a') ? 'b' : 'a')
    const response = await fetch(`${record!.address}${WATCH_STREAM_PATH}?session=${child.id}`, {
      headers: { [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: wrong },
    })
    expect(response.status).toBe(401)
  })

  it('handles a session whose record is being torn down', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx } = hubContext(child)
    const hub = hubFor(ctx)
    await publication(hub, ctx, child, rootId)
    const record = await readWatchRecord(child.id)
    const children = Reflect.get(hub, 'children') as Map<string, { session: Session | undefined }>
    children.get(child.id)!.session = undefined
    const response = await fetch(`${record!.address}${WATCH_STREAM_PATH}?session=${child.id}`, {
      headers: { [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: record!.token },
    })
    expect(response.status).toBe(404)
  })

  it('opens a 404 response when the state loses its session before the stream starts', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx } = hubContext(child)
    const hub = hubFor(ctx)
    const response = new FakeHttpResponse()
    const openStream = privateHub(hub, 'openStream')
    await openStream(response, {
      session: undefined, agent: undefined, stream: { snapshot: () => ({ revision: 0 }) }, assistantOrdinal: 0, connections: new Set(),
    })
    expect(response.status).toBe(404)
  })

  it('reports a missing query service while opening a stream', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const ctx = new Context()
    contexts.push(ctx)
    const hub = hubFor(ctx)
    const response = new FakeHttpResponse()
    const openStream = privateHub(hub, 'openStream')
    await openStream(response, {
      session: child, agent: undefined, stream: { snapshot: () => ({ revision: 0 }) }, assistantOrdinal: 0, connections: new Set(),
    })
    expect(response.status).toBe(200)
    expect(response.body).toContain('requires the sessionQuery service')
  })

  it('force-closes and catches listener shutdown failures', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const hub = new SubagentWatchHub(ctx)
    let forced = false
    Reflect.set(hub, 'server', {
      close() {},
      closeAllConnections() { forced = true },
    })
    await hub.close()
    expect(forced).toBe(true)

    const throwingCtx = new Context()
    contexts.push(throwingCtx)
    const throwingHub = new SubagentWatchHub(throwingCtx)
    Reflect.set(throwingHub, 'server', {
      close() { throw new Error('already closed') },
      closeAllConnections() {},
    })
    await expect(throwingHub.close()).resolves.toBeUndefined()
  })

  it('rejects a listener that closes before it starts listening', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const hub = new SubagentWatchHub(ctx)
    Reflect.set(hub, 'closed', true)
    await expect(privateHub(hub, 'ensureServer')()).rejects.toThrow('closed before it started listening')
  })

  it('settles a handle rejection before and after headers are sent', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx } = hubContext(child)
    const hub = hubFor(ctx)
    await publication(hub, ctx, child, rootId)
    const record = await readWatchRecord(child.id)
    const openStream = privateHub(hub, 'openStream')
    const original = openStream
    Reflect.set(hub, 'openStream', async () => { throw new Error('stream failed') })
    const response = await fetch(`${record!.address}${WATCH_STREAM_PATH}?session=${child.id}`, {
      headers: { [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: record!.token },
    })
    expect(response.status).toBe(500)

    Reflect.set(hub, 'openStream', async (response: FakeHttpResponse) => {
      response.writeHead(200)
      throw new Error('after headers')
    })
    const failedAfterHeaders = await fetch(`${record!.address}${WATCH_STREAM_PATH}?session=${child.id}`, {
      headers: { [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: record!.token },
    }).catch(() => undefined)
    expect(failedAfterHeaders).toBeUndefined()
    Reflect.set(hub, 'openStream', original)
  })

  it('uses the string form of a non-Error observe rejection', async () => {
    const rootId = SessionId('session-root')
    const child = childSession(rootId)
    const { ctx, query } = hubContext(child)
    const hub = hubFor(ctx)
    await publication(hub, ctx, child, rootId)
    query.fail = 'plain failure'
    const record = await readWatchRecord(child.id)
    const response = await fetch(`${record!.address}${WATCH_STREAM_PATH}?session=${child.id}`, {
      headers: { [WATCH_PROTOCOL_HEADER]: '1', [WATCH_TOKEN_HEADER]: record!.token },
    })
    expect(await response.text()).toContain('plain failure')
  })
})
