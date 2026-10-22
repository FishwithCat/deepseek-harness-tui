/**
 * The read-only terminal viewer for one local subagent session.
 *
 * It reuses the transcript model, message rendering, and scrolling components,
 * but creates no Agent, installs no answerer, and starts no stream service. Esc,
 * Ctrl+C, and Ctrl+D leave; a lost connection keeps the trusted screen and
 * reports the disconnect without reconnecting.
 * @module @deepseek-ai/dsh-tui-app/watch/viewer
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  Key,
  ScrollView,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { Component, TUI, Terminal } from '@earendil-works/pi-tui'
import type { AssistantStreamBaseline } from '@deepseek-ai/dsh-agent'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { ProjectionCheckpoint } from '@deepseek-ai/dsh-session-projection'
import { createTheme, resolveColorScheme, supportsColor } from '../ansi.ts'
import type { TuiTheme } from '../ansi.ts'
import type { Config } from '../config.ts'
import { internals } from '../app.ts'
import { createToolPresentationResolver } from '../tool-view.ts'
import { TerminalTranscript } from '../transcript.ts'
import { StatusBar, TranscriptView } from '../views.ts'
import { measureUsage } from '../measurement.ts'
import type { TuiMeasurement } from '../measurement.ts'
import { openWatchStream, WatchStreamError } from './client.ts'
import type { WatchStream, WatchStreamHandlers } from './client.ts'
import { readWatchHistory } from './history.ts'
import { readWatchRecord } from './record.ts'
import { agentAssistantFrame } from './protocol.ts'
import type { WatchAssistantFrame, WatchExecutionState, WatchSnapshotFrame } from './protocol.ts'

/** Everything one watch invocation needs from its launcher. */
export interface WatchAppOptions {
  /** The plugin context the tree mounted. */
  ctx: Context
  /** Validated app settings. */
  config: Config
  /** Child session id to view. */
  watch: string
  /** Request bounded process exit with `code`. */
  exit(code: number): void
}

/**
 * The pinned watch footer: child identity, execution and connection state,
 * followed by usage measured from the child's committed events.
 */
export class WatchStatusBar implements Component {
  private sessionId = ''
  private connection: 'online' | 'history' | 'disconnected' = 'history'
  private execution: WatchExecutionState | undefined
  private readonly usage: StatusBar

  /**
   * @param theme - the surface theme.
   */
  constructor(private readonly theme: TuiTheme) {
    this.usage = new StatusBar(theme)
  }

  /**
   * Replace the rendered facts.
   * @param facts - child identity, execution and connection state, and available usage.
   */
  set(facts: {
    sessionId: string
    connection: 'online' | 'history' | 'disconnected'
    execution?: WatchExecutionState | undefined
    measurement?: TuiMeasurement | undefined
  }): void {
    this.sessionId = facts.sessionId
    this.connection = facts.connection
    this.execution = facts.execution
    this.usage.set({ workspace: '', state: 'idle', model: '', ...facts.measurement })
  }

  /** Drop cached render state. */
  invalidate(): void {}

  /**
   * Render the footer.
   * @param width - the viewport width in columns.
   * @returns a blank margin, separator, identity, and usage lines within `width`.
   */
  render(width: number): string[] {
    const left = this.theme.dim(`watch ${this.sessionId}`)
    const right = `${this.connectionText()}${this.executionText()}`
    return ['', this.theme.border('─'.repeat(Math.max(0, width))), this.pairLine(left, right, width), this.usage.renderUsage(width)]
  }

  private connectionText(): string {
    switch (this.connection) {
      case 'online': return this.theme.accent('● online')
      case 'history': return this.theme.dim('● history')
      case 'disconnected': return this.theme.error('✘ disconnected')
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default: return ''
    }
  }

  private executionText(): string {
    if (this.execution === undefined) return ''
    if (this.execution === 'running') return `  ${this.theme.accent('● running')}`
    return `  ${this.theme.dim('○ idle')}`
  }

  /** Place the right group against the left at the footer's edges. */
  private pairLine(left: string, right: string, width: number): string {
    const leftWidth = visibleWidth(left)
    const available = width - leftWidth - 2
    const rightWidth = visibleWidth(right)
    if (rightWidth <= available) return left + ' '.repeat(width - leftWidth - rightWidth) + right
    if (available > 0) {
      const truncated = truncateToWidth(right, available, '')
      return left + ' '.repeat(width - leftWidth - visibleWidth(truncated)) + truncated
    }
    return truncateToWidth(left, width)
  }
}

/** The read-only viewer application. */
export class WatchApp {
  private readonly theme: TuiTheme
  private readonly transcript: TerminalTranscript
  private readonly transcriptView: TranscriptView
  private readonly statusBar: WatchStatusBar
  private readonly tui: TUI
  private readonly viewport: TuiAltScreen | undefined
  private readonly copySelection: (text: string) => Promise<boolean>
  private readonly disposers: (() => void)[] = []
  private stream: WatchStream | undefined
  private connection: 'online' | 'history' | 'disconnected' = 'history'
  private execution: WatchExecutionState | undefined
  private cursor = -1
  private streamRevision = 0
  private expectedChunk = 0
  private attemptId: string | undefined
  private failed = false
  private leaving = false
  private stopped = false
  private header: SessionHeader | undefined
  private inheritedEventCount = SessionLogOffset(0)
  private checkpoint: ProjectionCheckpoint = {}
  private measurement: TuiMeasurement | undefined

  private constructor(
    private readonly options: WatchAppOptions,
    terminal: Terminal,
  ) {
    this.theme = createTheme({
      enabled: supportsColor(process.env, process.stdout.isTTY),
      palette: resolveColorScheme(options.config.colorScheme, process.env),
    })
    this.transcript = new TerminalTranscript(createToolPresentationResolver(options.ctx, () => undefined))
    this.transcriptView = new TranscriptView(this.transcript, this.theme)
    this.statusBar = new WatchStatusBar(this.theme)
    this.copySelection = text => internals.copyClipboardText(text, (data) => { terminal.write(data) })
    this.viewport = options.config.screen === 'alternate' ? new TuiAltScreen(terminal, true, undefined, {
      mouse: true,
      copySelection: this.copySelection,
    }) : undefined
    this.tui = this.viewport ?? new TuiMainScreen(terminal, true)
  }

  /**
   * Open the viewer for one child session.
   * @param options - launcher context, settings, target, and exit request.
   * @returns the mounted viewer.
   * @throws when no interactive terminal exists, or the record, service, or history read fails.
   */
  static async boot(options: WatchAppOptions): Promise<WatchApp> {
    if (!internals.isInteractive()) {
      throw new Error('tui: an interactive terminal is required (stdin and stdout must be a TTY) for --watch')
    }
    await options.ctx.get('loader')?.await()
    const app = new WatchApp(options, internals.createTerminal())
    await app.open()
    app.mount()
    return app
  }

  /** Resolve online versus history, apply the opening cut, and mount the surface. */
  private async open(): Promise<void> {
    let record
    try {
      record = await readWatchRecord(this.options.watch)
    } catch (error: unknown) {
      throw new Error(`could not read the watch record for "${this.options.watch}": ${errorMessage(error)}`)
    }
    if (record !== undefined) {
      try {
        this.connection = 'online'
        const handlers: WatchStreamHandlers = {
          onSnapshot: (snapshot) => { this.applySnapshot(snapshot) },
          onEvent: (event) => { this.onEvent(event) },
          onAssistant: (frame) => { this.onAssistant(frame) },
          onStatus: (status) => { this.onStatus(status) },
          onExecutionEnd: () => { this.onExecutionEnd() },
          onServiceClosed: () => { this.disconnect('the watch service closed the connection') },
          onFailure: (error) => { this.disconnect(error.message) },
        }
        const stream = await openWatchStream(record, this.options.watch, handlers)
        this.stream = stream
        if (this.failed) {
          stream.close()
          this.stream = undefined
        }
        return
      } catch (error: unknown) {
        if (!(error instanceof WatchStreamError) || error.kind !== 'network') throw error
        // The record outlived its service: fall back to the stored log.
      }
    }
    this.connection = 'history'
    let history
    try {
      history = await readWatchHistory(this.options.ctx, this.options.watch)
    } catch (error: unknown) {
      throw new Error(`could not read session "${this.options.watch}": ${errorMessage(error)}`)
    }
    this.applyHistory(history.header, history.events)
  }

  /** Build the surface, subscribe to exit keys, and start rendering. */
  private mount(): void {
    if (this.viewport === undefined) {
      this.tui.addChild(this.transcriptView)
      this.tui.addChild(this.statusBar)
    } else {
      const scroll = new ScrollView(this.transcriptView, { follow: 'end', primary: true, scrollbar: 'auto' })
      this.viewport.setLayoutRoot(new VStack([
        { component: scroll, grow: 1 },
        { component: this.statusBar, shrink: 0 },
      ]))
    }
    this.disposers.push(this.tui.addInputListener((data) => {
      if (isKeyRelease(data)) return undefined
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.ctrl('d'))) {
        this.stop(0)
        return { consume: true }
      }
      if (matchesKey(data, Key.ctrl('l'))) {
        this.tui.requestRender(true)
        return { consume: true }
      }
      return undefined
    }))
    this.options.ctx.effect(() => () => { this.teardown() }, 'tui-watch.terminal')
    this.refresh()
    this.tui.start()
    this.tui.renderNow(true)
  }

  /**
   * Leave the viewer.
   * @param code - process exit code.
   */
  stop(code: number): void {
    if (this.leaving) return
    this.leaving = true
    this.stream?.close()
    this.stream = undefined
    this.teardown()
    this.options.exit(code)
  }

  /** Apply the complete opening cut and replay any active assistant attempt. */
  private applySnapshot(snapshot: WatchSnapshotFrame): void {
    this.resetMeasurement(snapshot.header, snapshot.events)
    this.transcript.reset()
    this.cursor = -1
    this.applyEvents(snapshot.events)
    if (this.cursor !== snapshot.cursor) {
      this.protocolFailure('the watch snapshot cut does not match its events')
      return
    }
    this.streamRevision = snapshot.assistantStream.revision
    this.expectedChunk = 0
    this.execution = snapshot.status
    const baseline = snapshot.assistantStream
    if (baseline.activeAttempt !== undefined) {
      try {
        this.replayAttempt(baseline)
      } catch (error: unknown) {
        this.protocolFailure(errorMessage(error))
        return
      }
    }
    this.refresh()
  }

  /** Replay the compact active attempt so a mid-response join shows its prefix. */
  private replayAttempt(baseline: AssistantStreamBaseline): void {
    const attempt = baseline.activeAttempt
    if (attempt === undefined) return
    this.transcript.applyFrame({
      type: 'start',
      attemptId: attempt.attemptId,
      revision: baseline.revision,
      turn: attempt.turn,
      step: attempt.step,
    })
    const chunks = expandAssistantStream(attempt.stream)
    if (chunks.length !== attempt.nextIndex) {
      throw new Error(`the watch stream baseline holds ${String(chunks.length)} chunks for index ${String(attempt.nextIndex)}`)
    }
    for (const [index, timed] of chunks.entries()) {
      this.transcript.applyFrame({
        type: 'chunk',
        attemptId: attempt.attemptId,
        revision: baseline.revision,
        index,
        time: timed.time,
        chunk: timed.chunk,
      })
    }
    this.expectedChunk = attempt.nextIndex
    this.attemptId = String(attempt.attemptId)
  }

  /** Fold stored history with sequence continuity checks. */
  private applyHistory(header: SessionHeader, events: readonly SessionEvent[]): void {
    this.resetMeasurement(header, events)
    this.transcript.reset()
    this.cursor = -1
    this.applyEvents(events)
    this.execution = undefined
    if (header.id !== this.options.watch) {
      this.failed = true
      this.transcript.notice('error', `history names session "${header.id}" for "${this.options.watch}"`)
    }
    this.refresh()
  }

  private applyEvents(events: readonly SessionEvent[]): void {
    for (const event of events) {
      if (event.seq !== this.cursor + 1) {
        this.protocolFailure(`session event ${String(event.seq)} followed ${String(this.cursor)}`)
        return
      }
      this.transcript.applyEvent(event)
      this.cursor = event.seq
    }
    this.measureEvents(events)
  }

  private onEvent(event: SessionEvent): void {
    if (this.failed) return
    if (this.cursor >= 0 && event.seq !== this.cursor + 1) {
      this.protocolFailure(`session event ${String(event.seq)} followed ${String(this.cursor)}`)
      return
    }
    if (this.cursor < 0 && event.seq !== 0) {
      this.protocolFailure(`session event ${String(event.seq)} arrived without its prefix`)
      return
    }
    this.transcript.applyEvent(event)
    this.measureEvents([event])
    this.cursor = event.seq
    this.refresh()
  }

  private onAssistant(frame: WatchAssistantFrame): void {
    if (this.failed) return
    if (frame.type === 'start' && frame.revision === 1 && this.streamRevision !== 0) {
      this.streamRevision = 0
      this.expectedChunk = 0
    }
    if (frame.revision !== this.streamRevision + 1) {
      this.protocolFailure(`assistant revision ${String(frame.revision)} followed ${String(this.streamRevision)}`)
      return
    }
    if (frame.type !== 'start' && String(frame.attemptId) !== this.attemptId) {
      this.protocolFailure(`assistant frame for attempt "${String(frame.attemptId)}" does not match "${String(this.attemptId)}"`)
      return
    }
    if (frame.type === 'chunk' && frame.index !== this.expectedChunk) {
      this.protocolFailure(`assistant chunk ${String(frame.index)} followed ${String(this.expectedChunk)}`)
      return
    }
    if (frame.type === 'end' && frame.index !== this.expectedChunk) {
      this.protocolFailure(`assistant end at ${String(frame.index)} followed ${String(this.expectedChunk)}`)
      return
    }
    this.streamRevision = frame.revision
    if (frame.type === 'start') {
      this.attemptId = String(frame.attemptId)
      this.expectedChunk = 0
    } else if (frame.type === 'chunk') {
      this.expectedChunk = frame.index + 1
    } else {
      this.expectedChunk = 0
      this.attemptId = undefined
    }
    this.transcript.applyFrame(agentAssistantFrame(frame))
    this.refresh()
  }

  private onStatus(status: WatchExecutionState): void {
    this.execution = status
    this.refresh()
  }

  private onExecutionEnd(): void {
    this.execution = 'idle'
    this.refresh()
  }

  /** Stop applying updates, keep the trusted screen, and report the disconnect. */
  private disconnect(message: string): void {
    if (this.failed) return
    this.failed = true
    this.connection = 'disconnected'
    this.stream?.close()
    this.stream = undefined
    this.transcript.notice('error', `${message}; the screen keeps its last complete output`)
    this.refresh()
  }

  private protocolFailure(message: string): void {
    if (this.failed) return
    this.failed = true
    this.connection = 'disconnected'
    this.stream?.close()
    this.stream = undefined
    this.transcript.notice('error', `watch protocol error: ${message}`)
    this.refresh()
  }

  private refresh(): void {
    if (this.stopped) return
    this.statusBar.set({
      sessionId: this.options.watch,
      connection: this.connection,
      execution: this.execution,
      measurement: this.measurement,
    })
    this.tui.requestRender()
  }

  /** Initialize projection state from the complete opening cut, including inherited history. */
  private resetMeasurement(header: SessionHeader, events: readonly SessionEvent[]): void {
    this.header = header
    this.checkpoint = {}
    this.measurement = undefined
    this.inheritedEventCount = SessionLogOffset(header.isSeeded
      ? events.findLast(event => event.type === 'session/end-seed' && event.data.inherited === true)?.seq ?? events.length
      : 0)
  }

  /** Advance cached projection state only when committed events arrive. */
  private measureEvents(events: readonly SessionEvent[]): void {
    const registry = this.options.ctx.get('sessionProjections')
    if (registry === undefined || this.header === undefined) return
    const result = registry.restore(
      this.checkpoint, events, SessionLogOffset(events[0]?.seq ?? 0), this.header, this.inheritedEventCount,
    )
    this.checkpoint = result.checkpoint
    this.measurement = measureUsage(result.snapshot.values, false)
  }

  /** Restore the terminal exactly once. */
  private teardown(): void {
    if (this.stopped) return
    this.stopped = true
    this.stream?.close()
    this.stream = undefined
    for (const dispose of this.disposers.splice(0)) dispose()
    this.tui.stop()
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
