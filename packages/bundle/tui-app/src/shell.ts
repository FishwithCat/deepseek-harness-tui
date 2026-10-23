/**
 * Local `!` commands: one foreground shell execution whose streamed output is a
 * transcript row. Nothing here reaches the model or the session log; the
 * executor, sandbox policy, and output bounds belong to the mounted services.
 * @module @deepseek-ai/dsh-tui-app/shell
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ShellExecution, ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
// Empty type import carries the optional sandbox policy a confining executor requires.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ShellEntry, TerminalTranscript } from './transcript.ts'

/**
 * Wall-clock bound requested for one local command. The executor clamps it to
 * its own `maxTimeoutMs`, so this is a request rather than a promise.
 */
export const SHELL_COMMAND_TIMEOUT_MS = 600_000

/** How often streamed output is folded into the row. */
const SHELL_POLL_MS = 150

/** What {@link ShellRunner.submit} learned. */
export type ShellStart =
  | { readonly started: true }
  | { readonly started: false; readonly reason: string }

/** Everything the runner needs from the application. */
export interface ShellRunnerOptions {
  /** Context carrying the shell executor, sandbox policy, and working directory. */
  ctx: Context
  /** Transcript model the row is appended to. */
  transcript: TerminalTranscript
  /** The live session whose sandbox policy applies. */
  session: () => Session
  /** Directory the command starts in. */
  cwd: () => string
  /** Repaint after a row changed. */
  changed: () => void
}

/** One execution in flight. */
interface RunningShell {
  /** Row identity the updates address. */
  readonly id: number
  /** When the row was appended, for the elapsed time. */
  readonly startedAt: number
  /** Cancels the request; the executor kills the process when it fires. */
  readonly controller: AbortController
  /** Bound requested for this run, echoed by the timeout status. */
  readonly timeoutMs: number
  /** Output folded so far. */
  output: string
  /** True when a read reported dropped bytes. */
  lossy: boolean
  /** Latest spill file a lossy read named. */
  spillPath: string | undefined
  /** Whole seconds already written into the row. */
  elapsedSeconds: number
  /** The prepared handle, absent while preparation is still running. */
  execution: ShellExecution | undefined
  /** Poll timer, present once the handle exists. */
  timer: ReturnType<typeof setInterval> | undefined
}

/**
 * Run one `!` command at a time and stream it into a transcript row.
 *
 * The application refuses a second command while {@link running} is true, so
 * this class owns no queue; it owns cancellation, streamed reads, and the
 * settled facts the row shows.
 */
export class ShellRunner {
  private current: RunningShell | undefined

  /**
   * @param options - context, transcript, session and directory accessors, and the repaint hook.
   */
  constructor(private readonly options: ShellRunnerOptions) {}

  /** Whether a command currently occupies the surface. */
  get running(): boolean {
    return this.current !== undefined
  }

  /**
   * Start one command.
   *
   * A refusal is returned rather than thrown so the caller can leave the
   * composer untouched; the only refusals are composition faults, because the
   * caller already owns the occupancy rules.
   * @param command - the text after the leading `!`.
   * @returns whether the row was appended, or why it was not.
   */
  submit(command: string): ShellStart {
    if (this.current !== undefined) return { started: false, reason: 'a shell command is still running' }
    const shell = this.options.ctx.get('shell')
    if (shell === undefined) return { started: false, reason: 'this deployment mounts no shell executor' }
    const controller = new AbortController()
    let spec: ShellExecSpec
    let mode: string | undefined
    try {
      // A confining executor needs the standing policy; resolving it can fail
      // when a deployment mounts one without the other, which is reported like
      // any other preparation fault instead of escaping the composer handler.
      const policy = shell.sandboxMode === undefined
        ? undefined
        : this.options.ctx.get('sandboxPolicy')?.resolve({ session: this.options.session() })
      if (shell.sandboxMode !== undefined && policy === undefined) {
        return { started: false, reason: 'this deployment confines the shell but mounts no sandbox policy' }
      }
      mode = policy?.mode
      spec = shell.resolve({
        command,
        workdir: this.options.cwd(),
        timeoutMs: SHELL_COMMAND_TIMEOUT_MS,
        signal: controller.signal,
        ...policy === undefined ? {} : { sandboxPolicy: policy },
      })
    } catch (error: unknown) {
      return { started: false, reason: `could not prepare the command: ${messageOf(error)}` }
    }
    const state: RunningShell = {
      id: this.options.transcript.appendShell(command, mode),
      startedAt: Date.now(),
      controller,
      timeoutMs: spec.timeoutMs,
      output: '',
      lossy: false,
      spillPath: undefined,
      elapsedSeconds: 0,
      execution: undefined,
      timer: undefined,
    }
    this.current = state
    this.options.changed()
    void this.start(shell.execute(spec), state)
    return { started: true }
  }

  /**
   * Stop the running command, keeping the output it already produced.
   * @returns whether a command was running.
   */
  cancel(): boolean {
    const state = this.current
    if (state === undefined) return false
    state.controller.abort()
    state.execution?.kill()
    return true
  }

  /**
   * Stop the running command and wait for it to close; used when the session
   * switches or the application exits, where the row cannot outlive the view.
   */
  async dispose(): Promise<void> {
    const state = this.current
    if (state === undefined) return
    this.cancel()
    if (state.timer !== undefined) clearInterval(state.timer)
    await state.execution?.done
    this.current = undefined
  }

  /**
   * Poll one read into the row.
   * @param state - the execution being folded.
   * @param final - whether this is the last read before settlement.
   */
  private poll(state: RunningShell, final: boolean): void {
    const execution = state.execution
    /* v8 ignore next -- the timer is created only after the handle is published */
    if (execution === undefined) return
    const read = execution.readOutput()
    const elapsed = Math.floor((Date.now() - state.startedAt) / 1000)
    const patch: Partial<Omit<ShellEntry, 'kind' | 'id'>> = {}
    if (read.delta !== '') {
      state.output += read.delta
      patch.output = state.output
    }
    if (read.lossy && !state.lossy) {
      state.lossy = true
      patch.lossy = true
    }
    const spill = read.stdoutSpillPath ?? read.stderrSpillPath
    if (spill !== undefined && spill !== state.spillPath) {
      state.spillPath = spill
      patch.spillPath = spill
    }
    if (!final && elapsed !== state.elapsedSeconds) {
      state.elapsedSeconds = elapsed
      patch.durationMs = Date.now() - state.startedAt
    }
    if (Object.keys(patch).length > 0) this.options.transcript.updateShell(state.id, patch)
  }

  /**
   * Prepare one execution and follow it to settlement.
   * @param prepared - the spawning promise returned by the executor.
   * @param state - the row this execution belongs to.
   */
  private async start(prepared: Promise<ShellExecution>, state: RunningShell): Promise<void> {
    let execution: ShellExecution
    try {
      execution = await prepared
    } catch (error: unknown) {
      this.fail(state, error)
      return
    }
    // The surface released this execution while it was still spawning (a
    // session switch or shutdown); it must not outlive the row it belongs to.
    if (this.current !== state) {
      execution.kill()
      await execution.done
      return
    }
    state.execution = execution
    this.poll(state, false)
    const timer = setInterval(() => { this.poll(state, false) }, SHELL_POLL_MS)
    state.timer = timer
    try {
      const result = await execution.result()
      this.settle(state, result, timer)
    } catch (error: unknown) {
      this.fail(state, error)
    }
  }

  /**
   * Write one settled outcome into the row and release the surface.
   * @param state - the executed row.
   * @param result - the executor's settled facts.
   * @param timer - the poll timer started with this execution.
   */
  private settle(state: RunningShell, result: ShellRunResult, timer: ReturnType<typeof setInterval>): void {
    clearInterval(timer)
    this.poll(state, true)
    const status: ShellEntry['status'] = result.aborted
      ? 'cancelled'
      : result.timedOut
        ? 'timedout'
        : result.exitCode === 0 ? 'ok' : 'error'
    this.options.transcript.updateShell(state.id, {
      status,
      output: state.output,
      durationMs: Date.now() - state.startedAt,
      ...result.sandbox === undefined ? {} : { mode: result.sandbox.mode },
      ...result.sandbox?.denied === true ? { sandboxDenied: true } : {},
      ...result.exitCode === null ? {} : { exitCode: result.exitCode },
      ...result.signal === null ? {} : { signal: result.signal },
      ...state.lossy ? { lossy: true } : {},
      ...state.spillPath === undefined ? {} : { spillPath: state.spillPath },
      ...status === 'timedout' ? { timeoutMs: state.timeoutMs } : {},
    })
    this.current = undefined
    this.options.changed()
  }

  /**
   * Write a preparation failure into the row and release the surface.
   * @param state - the row that never ran.
   * @param error - the rejection that ended preparation.
   */
  private fail(state: RunningShell, error: unknown): void {
    if (state.timer !== undefined) clearInterval(state.timer)
    const cancelled = state.controller.signal.aborted
    const text = messageOf(error)
    this.options.transcript.updateShell(state.id, {
      status: cancelled ? 'cancelled' : 'error',
      output: cancelled || state.output !== '' ? state.output : text,
      durationMs: Date.now() - state.startedAt,
    })
    this.current = undefined
    this.options.changed()
  }
}

/**
 * The right-aligned label of one shell row: whether it is local-only and which
 * sandbox mode confined it.
 * @param entry - the shell row.
 * @returns the label text.
 */
export function shellLabel(entry: ShellEntry): string {
  return entry.mode === undefined ? 'local' : `local · ${entry.mode}`
}

/**
 * The closing line of one shell row: its state and, once settled, how long it
 * took and how it ended.
 * @param entry - the shell row.
 * @returns the status text.
 */
export function shellStatusLine(entry: ShellEntry): string {
  const elapsed = entry.durationMs === undefined ? '' : ` · ${formatDuration(entry.durationMs)}`
  switch (entry.status) {
    case 'running': return `[running]${elapsed}`
    case 'cancelled': return `[cancelled]${elapsed}`
    case 'timedout': return `[timed out after ${formatSeconds((entry.timeoutMs ?? SHELL_COMMAND_TIMEOUT_MS) / 1000)}]${elapsed}`
    case 'ok':
    case 'error':
      if (entry.signal !== undefined) return `[signal ${entry.signal}]${elapsed}`
      if (entry.exitCode === undefined) return `[failed]${elapsed}`
      return `[exit code: ${String(entry.exitCode)}]${elapsed}`
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default: return ''
  }
}

/**
 * Format a settled duration for the closing line.
 * @param ms - elapsed milliseconds.
 * @returns seconds with one decimal.
 */
function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Format a timeout bound in whole seconds.
 * @param seconds - the bound in seconds.
 * @returns the seconds with a unit suffix.
 */
function formatSeconds(seconds: number): string {
  return `${String(Math.round(seconds))}s`
}

/**
 * Read a message out of a rejected value.
 * @param error - the rejection.
 * @returns its message, or the value's string form.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
