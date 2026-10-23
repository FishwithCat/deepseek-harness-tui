/**
 * Local `!` commands: the runner's row lifecycle and the rendered row. The
 * executor is a scripted double so truncation, timeouts, and cancellations are
 * deterministic; the transcript and view are the real ones.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type {
  CollectedOutput,
  ShellExecution,
  ShellExecRequest,
  ShellExecSpec,
  ShellProcessRead,
  ShellProcessStatus,
  ShellRunResult,
  ShellSandboxInfo,
} from '@deepseek-ai/dsh-shell'
import { SHELL_COMMAND_TIMEOUT_MS, ShellRunner, shellLabel, shellStatusLine } from '../src/shell.ts'
import { TerminalTranscript } from '../src/transcript.ts'
import { TranscriptView } from '../src/views.ts'
import { createTheme } from '../src/ansi.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** An empty collected stream. */
function collected(text = ''): CollectedOutput {
  return { text, truncated: false }
}

/** One offset reader that never has anything new. */
const emptyReader = {
  readFrom: (): { text: string; nextOffset: number; lossy: boolean } => ({ text: '', nextOffset: 0, lossy: false }),
}

/** A scripted foreground execution the test settles explicitly. */
class FakeExecution implements ShellExecution {
  status: ShellProcessStatus = 'running'
  exitCode: number | null = null
  signal: NodeJS.Signals | null = null
  sandbox?: ShellSandboxInfo
  readonly observed = { stdout: emptyReader, stderr: emptyReader }
  readonly done: Promise<void>
  /** Whether kill reached this execution. */
  killed = false
  /** Outcome kill settles immediately, standing in for a real process close. */
  settleOnKill: ShellRunResult | undefined
  private finishDone!: () => void
  private finishResult!: (result: ShellRunResult) => void
  private rejectForeground!: (error: unknown) => void
  private readonly resultPromise: Promise<ShellRunResult>
  private reads: ShellProcessRead[] = []

  constructor() {
    this.done = new Promise<void>((resolve) => { this.finishDone = resolve })
    this.resultPromise = new Promise<ShellRunResult>((resolve, reject) => {
      this.finishResult = resolve
      this.rejectForeground = reject
    })
  }

  /** Queue one incremental read for the runner's poll. */
  push(read: ShellProcessRead): void {
    this.reads.push(read)
  }

  readOutput(): ShellProcessRead {
    return this.reads.shift() ?? { delta: '', lossy: false }
  }

  kill(): boolean {
    if (this.status !== 'running') return false
    this.status = 'killed'
    this.killed = true
    if (this.settleOnKill !== undefined) this.settle(this.settleOnKill)
    return true
  }

  result(): Promise<ShellRunResult> {
    return this.resultPromise
  }

  /** Reject the foreground projection with an infrastructure failure. */
  failResult(error: Error): void {
    this.rejectForeground(error)
    this.finishDone()
  }

  /** Settle the process, resolving both `done` and `result()`. */
  settle(result: ShellRunResult): void {
    this.status = 'completed'
    this.exitCode = result.exitCode
    this.signal = result.signal
    if (result.sandbox !== undefined) this.sandbox = result.sandbox
    this.finishResult(result)
    this.finishDone()
  }
}

/** A scripted shell executor. */
class FakeExecutor {
  /** Mode this executor advertises; undefined means it does not confine. */
  sandboxMode: string | undefined
  /** Requests resolved by this executor. */
  readonly requests: ShellExecRequest[] = []
  /** Executions started by this executor. */
  readonly executions: FakeExecution[] = []
  /** Rejection the next `execute` produces instead of a handle. */
  failExecution: unknown
  /** Throw from `resolve`, to exercise preparation refusal. */
  failResolve = false
  /** Publish a handle even when the request was cancelled during preparation. */
  ignoreAbort = false

  constructor(sandboxMode?: string) {
    this.sandboxMode = sandboxMode
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    if (this.failResolve) throw new Error('resolver exploded')
    this.requests.push(request)
    return {
      command: request.command,
      workdir: request.workdir ?? '/workspace',
      timeoutMs: Math.min(request.timeoutMs ?? SHELL_COMMAND_TIMEOUT_MS, SHELL_COMMAND_TIMEOUT_MS),
      onExpiry: 'kill',
      stdoutMaxBytes: 64_000,
      ...request.signal === undefined ? {} : { signal: request.signal },
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    // Yield once so a cancellation issued right after submission races the
    // spawn the way a real executor's preparation does.
    await Promise.resolve()
    if (!this.ignoreAbort && spec.signal?.aborted === true) throw new Error('aborted')
    if (this.failExecution !== undefined) throw this.failExecution
    const execution = new FakeExecution()
    this.executions.push(execution)
    return execution
  }
}

/** One runner wired to a real transcript and a scripted executor. */
interface Harness {
  runner: ShellRunner
  transcript: TerminalTranscript
  executor: FakeExecutor
  session: Session
  renders: () => number
}

/**
 * Build one harness.
 * @param options - executor sandbox mode and whether a policy is mounted.
 * @returns the runner, its transcript, and the executor.
 */
async function harness(options: { sandboxMode?: string; policy?: boolean } = {}): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  const executor = new FakeExecutor(options.sandboxMode)
  ctx.provide('shell', executor as never)
  if (options.policy !== false) {
    const policy = { mode: 'workspace-write' as const, workspaceRoot: '/workspace' }
    ctx.provide('sandboxPolicy', { resolve: () => policy } as never)
  }
  const transcript = new TerminalTranscript()
  let renders = 0
  const runner = new ShellRunner({
    ctx,
    transcript,
    session: () => session,
    cwd: () => '/workspace',
    changed: () => { renders += 1 },
  })
  return { runner, transcript, executor, session, renders: () => renders }
}

/** The last row's shell entry, asserting it is one. */
function shellRow(transcript: TerminalTranscript) {
  const row = transcript.entries().at(-1)
  if (row?.kind !== 'shell') throw new Error('no shell row')
  return row
}

/** Wait one microtask turn so the spawning promise chain runs. */
async function tick(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('ShellRunner', () => {
  it('streams reads into one row and settles a zero exit', async () => {
    const test = await harness()
    expect(test.runner.submit('echo hi')).toEqual({ started: true })
    expect(test.executor.requests[0]?.command).toBe('echo hi')
    expect(test.executor.requests[0]?.workdir).toBe('/workspace')
    expect(test.runner.running).toBe(true)
    await tick()
    const execution = test.executor.executions[0]
    expect(execution).toBeDefined()
    execution?.push({ delta: 'hi\n', lossy: false })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(shellRow(test.transcript).output).toBe('hi\n')
    execution?.settle({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: SHELL_COMMAND_TIMEOUT_MS,
      stdout: collected('hi\n'),
      stderr: collected(),
    })
    await tick()
    expect(test.runner.running).toBe(false)
    expect(shellRow(test.transcript)).toMatchObject({
      status: 'ok',
      output: 'hi\n',
      exitCode: 0,
    })
    expect(shellRow(test.transcript).durationMs).toBeGreaterThanOrEqual(0)
    expect(test.renders()).toBeGreaterThan(1)
  })

  it('reports a nonzero exit, a signal, and an elapsed second', async () => {
    const test = await harness()
    test.runner.submit('false')
    await tick()
    const execution = test.executor.executions[0]
    execution?.push({ delta: 'oops\n', lossy: false })
    // Let the poll's whole-second branch rewrite the row before settlement.
    await new Promise(resolve => setTimeout(resolve, 1_100))
    execution?.settle({
      exitCode: 1,
      signal: 'SIGTERM',
      timedOut: false,
      aborted: false,
      timeoutMs: SHELL_COMMAND_TIMEOUT_MS,
      stdout: collected('oops\n'),
      stderr: collected(),
    })
    await tick()
    expect(shellRow(test.transcript)).toMatchObject({ status: 'error', exitCode: 1, signal: 'SIGTERM' })
    expect(shellStatusLine(shellRow(test.transcript))).toContain('[signal SIGTERM]')
    expect(shellStatusLine(shellRow(test.transcript))).toMatch(/· \d+\.\ds/)
  })

  it('settles a cancelled command as cancelled and keeps partial output', async () => {
    const test = await harness()
    test.runner.submit('sleep 5')
    await tick()
    const execution = test.executor.executions[0]
    execution?.push({ delta: 'partial\n', lossy: false })
    await new Promise(resolve => setTimeout(resolve, 60))
    if (execution !== undefined) {
      execution.settleOnKill = {
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: true,
        timeoutMs: SHELL_COMMAND_TIMEOUT_MS,
        stdout: collected(),
        stderr: collected(),
      }
    }
    expect(test.runner.cancel()).toBe(true)
    expect(execution?.killed).toBe(true)
    await tick()
    expect(shellRow(test.transcript)).toMatchObject({ status: 'cancelled', output: 'partial\n' })
    expect(shellStatusLine(shellRow(test.transcript))).toContain('[cancelled]')
    expect(test.runner.cancel()).toBe(false)
  })

  it('reports a timeout row that carries no bound with the requested one', () => {
    const transcript = new TerminalTranscript()
    const id = transcript.appendShell('sleep 1', undefined)
    transcript.updateShell(id, { status: 'timedout' })
    expect(shellStatusLine(shellRow(transcript))).toContain('[timed out after 600s]')
  })

  it('reports a timeout with the bound the executor applied', async () => {
    const test = await harness()
    test.runner.submit('sleep 900')
    await tick()
    test.executor.executions[0]?.settle({
      exitCode: null,
      signal: null,
      timedOut: true,
      aborted: false,
      timeoutMs: SHELL_COMMAND_TIMEOUT_MS,
      stdout: collected(),
      stderr: collected(),
    })
    await tick()
    expect(shellRow(test.transcript)).toMatchObject({ status: 'timedout', timeoutMs: SHELL_COMMAND_TIMEOUT_MS })
    expect(shellStatusLine(shellRow(test.transcript))).toContain('[timed out after 600s]')
  })

  it('records truncation and the spill file, and a sandbox denial', async () => {
    const test = await harness({ sandboxMode: 'workspace-write' })
    expect(test.runner.submit('rm -rf /')).toEqual({ started: true })
    expect(test.executor.requests[0]?.sandboxPolicy).toMatchObject({ mode: 'workspace-write' })
    expect(shellRow(test.transcript).mode).toBe('workspace-write')
    await tick()
    const execution = test.executor.executions[0]
    execution?.push({
      delta: 'tail\n',
      lossy: true,
      stdoutSpillPath: '/tmp/spill.out',
    })
    execution?.push({ delta: 'tail2\n', lossy: true, stderrSpillPath: '/tmp/spill.err' })
    await new Promise(resolve => setTimeout(resolve, 60))
    execution?.settle({
      exitCode: 1,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: SHELL_COMMAND_TIMEOUT_MS,
      stdout: collected('tail\ntail2\n'),
      stderr: collected(),
      sandbox: { mode: 'workspace-write', denied: true },
    })
    await tick()
    expect(shellRow(test.transcript)).toMatchObject({
      status: 'error',
      lossy: true,
      spillPath: '/tmp/spill.out',
      sandboxDenied: true,
      mode: 'workspace-write',
    })
    expect(shellLabel(shellRow(test.transcript))).toBe('local · workspace-write')
  })

  it('refuses when the deployment mounts no executor or no policy', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const transcript = new TerminalTranscript()
    const runner = new ShellRunner({
      ctx,
      transcript,
      session: () => { throw new Error('unused') },
      cwd: () => '/workspace',
      changed: () => {},
    })
    expect(runner.submit('ls')).toEqual({ started: false, reason: 'this deployment mounts no shell executor' })

    const confined = await harness({ sandboxMode: 'read-only', policy: false })
    expect(confined.runner.submit('ls')).toEqual({
      started: false,
      reason: 'this deployment confines the shell but mounts no sandbox policy',
    })
  })

  it('refuses a second command, a failed resolve, and an unexpected failure', async () => {
    const test = await harness()
    test.runner.submit('sleep 5')
    expect(test.runner.submit('ls')).toEqual({ started: false, reason: 'a shell command is still running' })
    await test.runner.dispose()

    test.executor.failResolve = true
    expect(test.runner.submit('ls')).toEqual({
      started: false,
      reason: 'could not prepare the command: resolver exploded',
    })

    test.executor.failResolve = false
    test.executor.failExecution = new Error('spawn failed')
    expect(test.runner.submit('ls')).toEqual({ started: true })
    await tick()
    expect(shellRow(test.transcript)).toMatchObject({ status: 'error', output: 'spawn failed' })

    test.executor.failExecution = 'not an error'
    expect(test.runner.submit('ls')).toEqual({ started: true })
    await tick()
    expect(shellRow(test.transcript)).toMatchObject({ status: 'error', output: 'not an error' })
  })

  it('settles a cancelled preparation without an error line', async () => {
    const test = await harness()
    test.runner.submit('sleep 5')
    // Cancelling before the handle is published aborts the spawn request.
    expect(test.runner.cancel()).toBe(true)
    await tick()
    const cancelled = shellRow(test.transcript)
    expect(cancelled.status).toBe('cancelled')
    expect(test.runner.running).toBe(false)
  })

  it('kills a command that finishes spawning after disposal', async () => {
    const test = await harness()
    test.executor.ignoreAbort = true
    test.runner.submit('sleep 5')
    // The surface releases the row while the spawn is still unresolved, so the
    // late handle must be killed rather than adopted.
    await test.runner.dispose()
    await tick()
    const execution = test.executor.executions[0]
    execution?.settle({
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: true,
      timeoutMs: SHELL_COMMAND_TIMEOUT_MS,
      stdout: collected(),
      stderr: collected(),
    })
    await tick()
    expect(execution?.killed).toBe(true)
    expect(test.runner.running).toBe(false)
  })

  it('reports a foreground projection that rejects', async () => {
    const test = await harness()
    test.runner.submit('ls')
    await tick()
    test.executor.executions[0]?.failResult(new Error('projection exploded'))
    await tick()
    expect(shellRow(test.transcript)).toMatchObject({ status: 'error', output: 'projection exploded' })
    expect(test.runner.running).toBe(false)
  })
})

describe('shell row rendering', () => {
  it('renders the command, its label, streamed output, and the state line', () => {
    const transcript = new TerminalTranscript()
    const id = transcript.appendShell('echo hi', undefined)
    transcript.updateShell(id, { status: 'ok', output: 'hi\n', exitCode: 0, durationMs: 800 })
    const rendered = new TranscriptView(transcript, createTheme({ enabled: false, palette: 'dark' }))
      .render(80)
      .join('\n')
    expect(rendered).toContain('! echo hi')
    expect(rendered).toContain('local')
    expect(rendered).toContain('> hi')
    expect(rendered).toContain('[exit code: 0] · 0.8s')
  })

  it('renders a multi-line command, truncation, and a sandbox denial', () => {
    const transcript = new TerminalTranscript()
    const id = transcript.appendShell('set -e\necho one', 'read-only')
    transcript.updateShell(id, {
      status: 'error',
      output: 'denied\n',
      exitCode: 1,
      durationMs: 40,
      lossy: true,
      spillPath: '/tmp/full.log',
      sandboxDenied: true,
    })
    const rendered = new TranscriptView(transcript, createTheme({ enabled: false, palette: 'dark' }))
      .render(80)
      .join('\n')
    expect(rendered).toContain('! set -e')
    expect(rendered).toContain('  echo one')
    expect(rendered).toContain('local · read-only')
    expect(rendered).toContain('[output truncated — full output: /tmp/full.log]')
    expect(rendered).toContain('[sandbox: file access denied under read-only]')
    expect(rendered).toContain('widen with DSH_PERMISSION_MODE=danger-full-access')
  })

  it('renders an execution that settled without an exit code or signal', () => {
    const transcript = new TerminalTranscript()
    const id = transcript.appendShell('false', undefined)
    transcript.updateShell(id, { status: 'error', output: '', durationMs: 10 })
    const rendered = new TranscriptView(transcript, createTheme({ enabled: false, palette: 'dark' }))
      .render(80)
      .join('\n')
    expect(rendered).toContain('[failed] · 0.0s')
  })

  it('names the standing mode when a denial carries none', () => {
    const transcript = new TerminalTranscript()
    const id = transcript.appendShell('rm /etc/hosts', undefined)
    transcript.updateShell(id, { status: 'error', exitCode: 1, sandboxDenied: true })
    const rendered = new TranscriptView(transcript, createTheme({ enabled: false, palette: 'dark' }))
      .render(80)
      .join('\n')
    expect(rendered).toContain('[sandbox: file access denied under the standing mode]')
  })

  it('drops the label before shortening a command that already fills the row', () => {
    const transcript = new TerminalTranscript()
    const id = transcript.appendShell('x'.repeat(60), 'workspace-write')
    transcript.updateShell(id, { status: 'ok', exitCode: 0 })
    const narrow = new TranscriptView(transcript, createTheme({ enabled: false, palette: 'dark' })).render(30).join('\n')
    expect(narrow).not.toContain('workspace-write')
    const shortened = new TranscriptView(transcript, createTheme({ enabled: false, palette: 'dark' })).render(70).join('\n')
    expect(shortened).not.toContain('workspace-write')
    const tiny = new TranscriptView(transcript, createTheme({ enabled: false, palette: 'dark' })).render(4).join('\n')
    expect(tiny.length).toBeGreaterThan(0)
  })

  it('renders a timed-out row with the warning style', () => {
    const transcript = new TerminalTranscript()
    const id = transcript.appendShell('sleep 900', undefined)
    transcript.updateShell(id, { status: 'timedout', timeoutMs: SHELL_COMMAND_TIMEOUT_MS })
    const rendered = new TranscriptView(transcript, createTheme({ enabled: false, palette: 'dark' }))
      .render(80)
      .join('\n')
    expect(rendered).toContain('[timed out after 600s]')
  })

  it('renders a running row without a duration and a truncated note without a spill path', () => {
    const transcript = new TerminalTranscript()
    const id = transcript.appendShell('sleep 1', undefined)
    transcript.updateShell(id, { lossy: true })
    const rendered = new TranscriptView(transcript, createTheme({ enabled: false, palette: 'dark' }))
      .render(80)
      .join('\n')
    expect(rendered).toContain('[running]')
    expect(rendered).toContain('[output truncated]')
  })
})
