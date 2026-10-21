/**
 * The publishing side of cross-terminal subagent watching.
 *
 * One hub serves every local subagent in the TUI's session tree from a single
 * loopback HTTP listener. It owns the HTTP service, the lifecycle/event
 * subscriptions, the shared assistant-stream state, per-client bounded write
 * queues, and the runtime connection records. It never changes agent-loop.
 * @module @deepseek-ai/dsh-tui-app/watch/server
 */

import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { AssistantStreamState } from '@deepseek-ai/dsh-agent'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId, SessionSeqCursor } from '@deepseek-ai/dsh-session'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-session-query'
import {
  WATCH_PROTOCOL_HEADER,
  WATCH_PROTOCOL_VERSION,
  WATCH_STREAM_PATH,
  WATCH_TOKEN_HEADER,
  wireAssistantFrame,
} from './protocol.ts'
import type {
  WatchAssistantFrame,
  WatchConnectionRecord,
  WatchExecutionState,
  WatchServerFrame,
  WatchSnapshotFrame,
} from './protocol.ts'
import { publishWatchRecord, removeOwnedWatchRecord, removeOwnedWatchRecords } from './record.ts'

/** Largest number of bytes a single viewer may fall behind before it is disconnected. */
export const WATCH_CLIENT_MAX_QUEUED_BYTES = 1_000_000

/** Largest number of frames a single viewer may fall behind before it is disconnected. */
export const WATCH_CLIENT_MAX_QUEUED_FRAMES = 4_096

/**
 * Interval between empty-stream heartbeats. Node's fetch body timeout is five
 * minutes, so a quiet child stream needs traffic well inside that window.
 */
export const WATCH_HEARTBEAT_MS = 20_000

/** Callbacks the owning TUI registers to report publication outcomes. */
export interface SubagentWatchHooks {
  /**
   * A child's watch record is published; the command is safe to show.
   * @param sessionId - the viewable child session.
   * @param command - shell command naming only the session id.
   */
  published(sessionId: SessionId, command: string): void
  /**
   * A child could not be made viewable.
   * @param sessionId - the child session.
   * @param error - the publication or listener failure.
   */
  failed(sessionId: SessionId, error: unknown): void
}

/** One frame held while an opening snapshot is read. */
interface HeldFrame {
  readonly frame: WatchServerFrame
  /** Monotonic per-child arrival position for assistant frames. */
  readonly assistantOrdinal?: number
}

/** One tracked local child and its process-local stream. */
interface ChildState {
  readonly sessionId: SessionId
  agent: Agent | undefined
  session: Session | undefined
  readonly stream: AssistantStreamState
  /** Last assistant frame arrival position, independent of revision resets. */
  assistantOrdinal: number
  readonly connections: Set<WatchConnection>
}

/**
 * One viewer's NDJSON response with an independent bounded queue.
 *
 * A viewer that stops reading falls behind in this queue rather than in the
 * Agent's event loop. Exceeding either bound destroys that response and leaves
 * every other viewer and the Agent untouched.
 */
export class WatchConnection {
  private readonly queue: string[] = []
  private queuedBytes = 0
  private closed = false
  private ending = false
  private notified = false
  private paused = false
  private blocked = false
  private readonly held: HeldFrame[] = []
  private heldBytes = 0
  private readonly heartbeat: NodeJS.Timeout

  /**
   * @param response - the HTTP response this connection owns.
   * @param onClose - called exactly once when the response ends or is destroyed.
   */
  constructor(
    private readonly response: ServerResponse,
    private readonly onClose: () => void,
  ) {
    this.heartbeat = setInterval(() => {
      this.send({ type: 'heartbeat' })
    }, WATCH_HEARTBEAT_MS)
    this.heartbeat.unref()
    response.on('close', () => { this.notifyClose() })
    response.on('error', () => { this.notifyClose() })
    response.on('drain', () => {
      this.blocked = false
      this.pump()
    })
  }

  /** Whether this connection can still accept frames. */
  get writable(): boolean {
    return !this.closed && !this.ending
  }

  /**
   * Queue one frame for the viewer.
   * @param frame - the frame to serialize.
   * @returns false when the frame was dropped because the queue is full.
   */
  send(frame: WatchServerFrame): boolean {
    return this.enqueue(frame)
  }

  /**
   * Queue one assistant frame tagged with its arrival position.
   *
   * Revision restarts when the Agent lifecycle is replaced, so the opening
   * snapshot cuts held assistant frames by arrival position rather than
   * revision.
   * @param frame - the assistant wire frame.
   * @param ordinal - monotonic per-child arrival position.
   * @returns false when the frame was dropped because the queue is full.
   */
  sendAssistant(frame: WatchAssistantFrame, ordinal: number): boolean {
    return this.enqueue({ type: 'assistant', frame }, ordinal)
  }

  private enqueue(frame: WatchServerFrame, assistantOrdinal?: number): boolean {
    if (this.paused) {
      const bytes = Buffer.byteLength(JSON.stringify(frame), 'utf8')
      if (this.held.length >= WATCH_CLIENT_MAX_QUEUED_FRAMES
        || this.heldBytes + bytes > WATCH_CLIENT_MAX_QUEUED_BYTES) {
        this.abort()
        return false
      }
      this.held.push({ frame, ...assistantOrdinal === undefined ? {} : { assistantOrdinal } })
      this.heldBytes += bytes
      return true
    }
    return this.write(`${JSON.stringify(frame)}\n`)
  }

  /** Hold live frames while an opening snapshot is read. */
  pause(): void {
    this.paused = true
  }

  /**
   * Write the one opening snapshot outside the incremental queue bound.
   *
   * A complete history line can exceed the per-increment budget; it is written
   * once, before any held increment, and is the only frame allowed to do so.
   * @param frame - the opening snapshot.
   */
  sendSnapshot(frame: WatchSnapshotFrame): void {
    if (this.closed) return
    const payload = `${JSON.stringify(frame)}\n`
    this.queue.push(payload)
    this.queuedBytes += Buffer.byteLength(payload, 'utf8')
    this.pump()
  }

  /**
   * Release held frames, dropping the ones the snapshot already represents.
   * @param cursor - last durable seq in the snapshot.
   * @param assistantOrdinal - last assistant arrival position in the snapshot.
   */
  resume(cursor: number, assistantOrdinal: number): void {
    this.paused = false
    this.heldBytes = 0
    for (const held of this.held) {
      const frame = held.frame
      if (frame.type === 'event' && frame.event.seq <= cursor) continue
      if (frame.type === 'assistant'
        && held.assistantOrdinal !== undefined
        && held.assistantOrdinal <= assistantOrdinal) continue
      if (!this.write(`${JSON.stringify(frame)}\n`)) break
    }
    this.held.length = 0
  }

  /**
   * Queue free-form NDJSON text.
   * @param payload - one complete line, including its newline.
   * @returns false when the payload was dropped because the queue is full.
   */
  write(payload: string): boolean {
    if (!this.writable) return false
    const bytes = Buffer.byteLength(payload, 'utf8')
    if (this.queuedBytes + bytes > WATCH_CLIENT_MAX_QUEUED_BYTES
      || this.queue.length >= WATCH_CLIENT_MAX_QUEUED_FRAMES) {
      this.abort()
      return false
    }
    this.queue.push(payload)
    this.queuedBytes += bytes
    this.pump()
    return true
  }

  /** Flush queued frames, then end the response. */
  end(): void {
    if (this.paused) {
      this.paused = false
      const held = this.held.splice(0)
      this.heldBytes = 0
      for (const { frame } of held) this.write(`${JSON.stringify(frame)}\n`)
    }
    this.ending = true
    this.pump()
  }

  /** Drop the connection immediately, discarding queued frames. */
  abort(): void {
    if (this.closed) return
    this.closed = true
    this.queue.length = 0
    this.held.length = 0
    this.heldBytes = 0
    this.queuedBytes = 0
    this.response.destroy()
    this.notifyClose()
  }

  private notifyClose(): void {
    this.closed = true
    clearInterval(this.heartbeat)
    if (this.notified) return
    this.notified = true
    this.onClose()
  }

  private pump(): void {
    if (this.closed || this.blocked) return
    while (this.queue.length > 0) {
      const payload = this.queue.shift() as string
      this.queuedBytes -= Buffer.byteLength(payload, 'utf8')
      try {
        if (!this.response.write(payload)) {
          this.blocked = true
          return
        }
      } catch (error: unknown) {
        // A destroyed socket is a viewer failure, not an Agent failure.
        void error
        this.abort()
        return
      }
    }
    if (!this.ending) return
    this.response.end()
    this.notifyClose()
  }
}

/**
 * Owns the loopback service, the tracked child states, and the published
 * records for one TUI process.
 */
export class SubagentWatchHub {
  private readonly serviceInstanceId = randomUUID()
  private readonly token = randomBytes(32).toString('base64url')
  private rootSessionId: SessionId | undefined
  private hooks: SubagentWatchHooks | undefined
  private server: Server | undefined
  private starting: Promise<string> | undefined
  private readonly children = new Map<SessionId, ChildState>()
  private readonly published = new Set<SessionId>()
  private readonly disposers: (() => void)[] = []
  private closed = false
  private closing: Promise<void> | undefined

  /** Whether close() has started; a getter avoids narrowing across awaits. */
  private get isClosed(): boolean {
    return this.closed
  }

  /**
   * @param ctx - the TUI plugin context carrying the Agent registry.
   */
  constructor(private readonly ctx: Context) {}

  /**
   * Begin tracking one root session's local subagent tree.
   * @param rootSessionId - the TUI's own session.
   * @param hooks - publication outcomes to report to the surface.
   */
  activate(rootSessionId: SessionId, hooks: SubagentWatchHooks): void {
    if (this.closed) return
    if (this.rootSessionId !== undefined && this.rootSessionId !== rootSessionId) {
      void this.rebind(rootSessionId)
      this.hooks = hooks
      return
    }
    this.rootSessionId = rootSessionId
    this.hooks = hooks
    if (this.disposers.length > 0) return
    this.disposers.push(
      this.ctx.on('subagent/start', (info) => { this.onStart(info) }),
      this.ctx.on('subagent/end', (info) => { this.onEnd(info) }),
      this.ctx.on('session/event', (session, event) => { this.onSessionEvent(session, event) }),
      this.ctx.on('agent/assistant-stream', ({ agent, frame }) => { this.onAssistantFrame(agent, frame) }),
      this.ctx.on('agent/status', ({ agent }) => { this.onAgentStatus(agent) }),
      this.ctx.on('agent/disposed', ({ agent }) => { this.onAgentDisposed(agent) }),
    )
  }

  /**
   * Move the tracked root to a replaced TUI session.
   * @param rootSessionId - the replacement root.
   */
  async rebind(rootSessionId: SessionId): Promise<void> {
    const published = [...this.published]
    this.published.clear()
    for (const state of this.children.values()) {
      for (const connection of state.connections) {
        connection.send({ type: 'service-closed' })
        connection.end()
      }
    }
    this.children.clear()
    await removeOwnedWatchRecords(published, this.serviceInstanceId)
    this.rootSessionId = rootSessionId
  }

  /**
   * Close the service, settle every viewer, and remove this instance's records.
   * Repeat calls await the same completion.
   * @returns completion after the listener and every record are gone.
   */
  close(): Promise<void> {
    return this.closing ??= this.closeOnce()
  }

  private async closeOnce(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const state of this.children.values()) {
      for (const connection of state.connections) {
        connection.send({ type: 'service-closed' })
        connection.end()
      }
    }
    this.children.clear()
    const server = this.server
    this.server = undefined
    this.starting = undefined
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          server.closeAllConnections()
          resolve()
        }, 250)
        force.unref()
        try {
          server.close(() => {
            clearTimeout(force)
            resolve()
          })
        } catch {
          // The listener never started, so there is nothing to close.
          clearTimeout(force)
          resolve()
        }
      })
    }
    const published = [...this.published]
    this.published.clear()
    await removeOwnedWatchRecords(published, this.serviceInstanceId)
  }

  /** Track one published local child synchronously, before its first model frame. */
  private onStart(info: SubagentRunInfo): void {
    if (this.closed || !info.local || this.rootSessionId === undefined) return
    const agent = this.ctx.agents.get(info.id)
    if (agent === undefined) return
    const parent = agent.session.header.parentSession
    if (parent === undefined) return
    if (parent !== this.rootSessionId && !this.children.has(parent)) return
    const existing = this.children.get(info.id)
    const state: ChildState = existing ?? {
      sessionId: info.id,
      agent,
      session: agent.session,
      stream: new AssistantStreamState(),
      assistantOrdinal: 0,
      connections: new Set(),
    }
    state.agent = agent
    state.session = agent.session
    this.children.set(info.id, state)
    void this.publish(info.id, state)
  }

  /** Report one settled execution without closing its viewer. */
  private onEnd(info: SubagentRunEndInfo): void {
    const state = this.children.get(info.id)
    if (state === undefined) return
    for (const connection of state.connections) {
      connection.send({ type: 'execution-end', stopReason: info.stopReason })
    }
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    const state = this.children.get(session.id)
    if (state === undefined || state.session !== session) return
    for (const connection of state.connections) {
      connection.send({ type: 'event', event })
    }
  }

  private onAssistantFrame(agent: Agent, frame: AssistantStreamFrame): void {
    const state = this.children.get(agent.session.id)
    if (state === undefined || state.agent !== agent) return
    const cursor: SessionSeqCursor = agent.session.seq === 0 ? -1 : SessionSeq(agent.session.seq - 1)
    state.stream.accept(frame, cursor)
    state.assistantOrdinal += 1
    const wire = wireAssistantFrame(frame, cursor)
    for (const connection of state.connections) {
      connection.sendAssistant(wire, state.assistantOrdinal)
    }
  }

  private onAgentStatus(agent: Agent): void {
    const state = this.children.get(agent.session.id)
    if (state === undefined || state.agent !== agent) return
    const status: WatchExecutionState = agent.status === 'running' ? 'running' : 'idle'
    for (const connection of state.connections) {
      connection.send({ type: 'status', status })
    }
  }

  private onAgentDisposed(agent: Agent): void {
    const state = this.children.get(agent.session.id)
    if (state !== undefined && state.agent === agent) state.agent = undefined
  }

  /** Start the loopback listener once, then publish one child's record. */
  private async publish(sessionId: SessionId, state: ChildState): Promise<void> {
    try {
      if (this.ctx.get('sessionQuery') === undefined) {
        throw new Error('watching requires the sessionQuery service')
      }
      const address = await this.ensureServer()
      if (this.closed || this.children.get(sessionId) !== state || this.rootSessionId === undefined) return
      const record: WatchConnectionRecord = {
        protocol: WATCH_PROTOCOL_VERSION,
        serviceInstanceId: this.serviceInstanceId,
        sessionId,
        rootSessionId: this.rootSessionId,
        address,
        token: this.token,
      }
      await publishWatchRecord(record)
      if (this.isClosed || this.children.get(sessionId) !== state) {
        await removeOwnedWatchRecord(sessionId, this.serviceInstanceId)
        return
      }
      this.published.add(sessionId)
      this.hooks?.published(sessionId, `dsh watch ${sessionId}`)
    } catch (error: unknown) {
      if (!this.closed) this.hooks?.failed(sessionId, error)
    }
  }

  private ensureServer(): Promise<string> {
    this.starting ??= new Promise<string>((resolve, reject) => {
      const server = createServer((request, response) => {
        this.handle(request, response)
      })
      this.server = server
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        if (this.closed) {
          server.close()
          reject(new Error('the watch service closed before it started listening'))
          return
        }
        const address = server.address()
        /* v8 ignore next 3 -- a listening TCP socket always reports an AddressInfo */
        if (address === null || typeof address === 'string') {
          reject(new Error('the watch service has no TCP address'))
          return
        }
        resolve(`http://127.0.0.1:${address.port}`)
      })
    }).catch((error: unknown) => {
      this.starting = undefined
      this.server = undefined
      throw error
    })
    return this.starting
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const rejectHttp = (status: number, message: string): void => {
      if (response.headersSent) return
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(`${JSON.stringify({ error: message })}\n`)
    }
    try {
      if (request.method !== 'GET') {
        rejectHttp(405, 'the watch stream is read-only')
        return
      }
      if (this.rootSessionId === undefined) {
        rejectHttp(404, 'the watch service serves no session tree')
        return
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== WATCH_STREAM_PATH) {
        rejectHttp(404, 'unknown watch endpoint')
        return
      }
      if (request.headers[WATCH_PROTOCOL_HEADER] !== String(WATCH_PROTOCOL_VERSION)) {
        rejectHttp(426, `unsupported watch protocol; expected ${String(WATCH_PROTOCOL_VERSION)}`)
        return
      }
      const token = request.headers[WATCH_TOKEN_HEADER]
      if (typeof token !== 'string' || !this.tokenMatches(token)) {
        rejectHttp(401, 'invalid watch token')
        return
      }
      const sessionId = url.searchParams.get('session')
      if (sessionId === null || sessionId === '') {
        rejectHttp(400, 'missing session id')
        return
      }
      const state = this.children.get(sessionId as SessionId)
      if (state === undefined || state.session === undefined) {
        rejectHttp(404, 'that session is not viewable from this service')
        return
      }
      void this.openStream(response, state).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy()
          return
        }
        rejectHttp(500, error instanceof Error ? error.message : String(error))
      })
    } catch (error: unknown) {
      rejectHttp(500, error instanceof Error ? error.message : String(error))
    }
  }

  private tokenMatches(candidate: string): boolean {
    const expected = Buffer.from(this.token, 'utf8')
    const actual = Buffer.from(candidate, 'utf8')
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  /**
   * Subscribe first, read the opening cut, send it, then release only the
   * increments after that cut.
   */
  private async openStream(response: ServerResponse, state: ChildState): Promise<void> {
    const session = state.session
    if (session === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(`${JSON.stringify({ error: 'the session is no longer available' })}\n`)
      return
    }
    response.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    const connection = new WatchConnection(response, () => {
      state.connections.delete(connection)
    })
    state.connections.add(connection)
    connection.pause()
    let snapshot: WatchSnapshotFrame
    try {
      const query = this.ctx.get('sessionQuery')
      if (query === undefined) throw new Error('watching requires the sessionQuery service')
      const observation = await query.observeSession(session.id, { projectionMode: 'none' })
      try {
        if (observation.header.id !== session.id) {
          throw new Error(`session query returned "${observation.header.id}" for "${session.id}"`)
        }
        const events = [...observation.events]
        const cursor: SessionSeqCursor = observation.cursor
        const assistantStream = state.stream.snapshot()
        snapshot = {
          type: 'snapshot',
          serviceInstanceId: this.serviceInstanceId,
          header: observation.header,
          cursor,
          events,
          status: state.agent?.status === 'running' ? 'running' : 'idle',
          assistantStream,
        }
      } finally {
        observation[Symbol.dispose]()
      }
    } catch (error: unknown) {
      connection.send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      connection.end()
      return
    }
    connection.sendSnapshot(snapshot)
    connection.resume(snapshot.cursor, state.assistantOrdinal)
  }
}
