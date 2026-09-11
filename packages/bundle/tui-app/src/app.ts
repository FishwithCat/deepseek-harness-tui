/**
 * The interactive terminal application: builds the pi-tui surface, owns the one
 * session it drives, routes composer input to local commands, the command
 * registry, or the Agent, and restores the terminal on exit.
 * @module @deepseek-ai/dsh-tui-app/app
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import {
  Editor,
  Input,
  Key,
  ProcessTerminal,
  ScrollView,
  SelectList,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  matchesKey,
} from '@earendil-works/pi-tui'
import type { OverlayHandle, SelectItem, TUI, Terminal } from '@earendil-works/pi-tui'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Empty type import carries the optional persistence read used by `/resume`.
import type {} from '@deepseek-ai/dsh-session-persistence'
// Empty type import carries the optional compaction policy read used by the footer.
import type {} from '@deepseek-ai/dsh-compaction'
// Empty type import carries the optional measurement projection the footer reads.
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ContextPressureProjection } from '@deepseek-ai/dsh-token-meter/client'
import { createTheme, editorTheme, selectListTheme, supportsColor } from './ansi.ts'
import type { TuiTheme } from './ansi.ts'
import type { Config } from './config.ts'
import { commandCatalog, executeCommand, listModelChoices, parseCommand } from './commands.ts'
import { installApprovalAnswerer, installQuestionAnswerer } from './interactions.ts'
import type { InteractionHost } from './interactions.ts'
import { TuiSession } from './session.ts'
import type { TuiSessionOptions } from './session.ts'
import type { TuiStartupValues } from './startup.ts'
import { PlaceholderEditor, PromptPanel, StatusBar, TranscriptView, modelLabel } from './views.ts'
import type { TuiContextStatus, TuiStatus } from './views.ts'
import { Transcript } from './transcript.ts'

/** Longest stored-session list rendered by `/sessions`. */
const SESSION_LIST_LIMIT = 20
/** Selectable items shown at once in a prompt overlay. */
const PROMPT_VISIBLE_ITEMS = 10

/** Process-facing effects the app needs; tests substitute them. */
export const internals: {
  /** Build the terminal the TUI drives. */
  createTerminal: () => Terminal
  /** Whether this invocation has an interactive terminal. */
  isInteractive: () => boolean
  /** Sink for boot failures the app cannot report through the UI. */
  stderr: { write(chunk: string): unknown }
} = {
  createTerminal: () => new ProcessTerminal(),
  isInteractive: () => process.stdin.isTTY && process.stdout.isTTY,
  stderr: process.stderr,
}

/** Everything one TUI invocation needs from its launcher. */
export interface TuiAppOptions {
  /** The plugin context the tree mounted. */
  ctx: Context
  /** Validated app settings. */
  config: Config
  /** Working directory the session starts in. */
  cwd: string
  /** Parsed invocation values, read from the startup provider. */
  invocation: TuiStartupValues
  /** Request bounded process exit with `code`. */
  exit(code: number): void
}

/**
 * Whether a terminal error happened because the app is already gone.
 * @param error - the rejected value.
 * @returns true for an abort or teardown rejection.
 */
function isTeardown(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message.includes('disposed'))
}

/** The interactive application. */
export class TuiApp implements InteractionHost {
  private readonly tui: TUI
  private readonly viewport: TuiAltScreen | undefined
  private readonly theme: TuiTheme
  private readonly transcript = new Transcript()
  private readonly transcriptView: TranscriptView
  private readonly statusBar: StatusBar
  private readonly editor: Editor
  private readonly composer: PlaceholderEditor
  private readonly disposers: (() => void)[] = []
  private session: TuiSession
  private leaving = false
  private stopped = false
  private promptActive = false
  private promptChain: Promise<unknown> = Promise.resolve()
  /** Providers the deployment registered; more than one qualifies the footer's model label. */
  private readonly providerCount: number
  /** Whether the mounted compaction engine schedules its own work. */
  private readonly autoCompaction: boolean
  /** Context occupancy cached against the session log position it was read at. */
  private contextCache: { seq: number; value: TuiContextStatus | undefined } | undefined

  private constructor(
    private readonly options: TuiAppOptions,
    session: TuiSession,
    terminal: Terminal,
  ) {
    this.session = session
    this.theme = createTheme(supportsColor(process.env, process.stdout.isTTY))
    this.providerCount = options.ctx.llm.listProviders().length
    this.autoCompaction = options.ctx.get('compaction')?.autoCompactionEnabled ?? false
    this.viewport = options.config.screen === 'alternate' ? new TuiAltScreen(terminal, true, undefined, { mouse: true }) : undefined
    this.tui = this.viewport ?? new TuiMainScreen(terminal, true)
    this.transcriptView = new TranscriptView(this.transcript, this.theme)
    this.statusBar = new StatusBar(this.theme)
    this.editor = new Editor(this.tui, editorTheme(this.theme), { paddingX: 1 })
    this.editor.onSubmit = (text) => { this.submit(text) }
    this.composer = new PlaceholderEditor(this.editor, this.theme)
  }

  /**
   * Boot one interactive TUI over the composed tree.
   * @param options - the launcher's context, settings, invocation, and exit request.
   * @returns the running application.
   * @throws when the invocation has no interactive terminal.
   */
  static async boot(options: TuiAppOptions): Promise<TuiApp> {
    if (!internals.isInteractive()) {
      throw new Error('tui: an interactive terminal is required (stdin and stdout must be a TTY); '
        + 'use `dsh --profile headless "<task>"` for non-interactive runs')
    }
    // Loader siblings mount concurrently: the Agent's scoped tools must be
    // composed before it exists.
    await options.ctx.get('loader')?.await()
    const sessionOptions = {
      cwd: options.cwd,
      provider: options.invocation.provider,
      model: options.invocation.model,
    }
    const session = options.invocation.resume === undefined
      ? await TuiSession.create(options.ctx, sessionOptions)
      : await TuiSession.resume(options.ctx, options.invocation.resume, sessionOptions)
    const app = new TuiApp(options, session, internals.createTerminal())
    app.mount()
    return app
  }

  /**
   * Build the surface, subscribe to the session, and start the terminal UI.
   */
  mount(): void {
    this.attach(this.session)
    if (this.viewport === undefined) {
      this.tui.addChild(this.transcriptView)
      this.tui.addChild(this.composer)
      this.tui.addChild(this.statusBar)
    } else {
      // The transcript is the primary scroll view: the alternate-screen
      // renderer routes PageUp/PageDown and the wheel to it while the composer
      // and the footer stay pinned below.
      const scroll = new ScrollView(this.transcriptView, { follow: 'end', primary: true, scrollbar: 'auto' })
      this.viewport.setLayoutRoot(new VStack([
        { component: scroll, grow: 1, basis: 0 },
        this.composer,
        this.statusBar,
      ]))
    }
    this.registerKeys()
    this.options.ctx.effect(() => () => { this.teardown() }, 'tui-app.terminal')
    this.refresh()
    this.tui.setFocus(this.composer)
    this.tui.start()
    this.tui.renderNow(true)
  }

  /**
   * Stop the application, drain the session, and request process exit.
   * @param code - the process exit code.
   */
  async stop(code: number): Promise<void> {
    if (this.leaving) return
    this.leaving = true
    this.teardown()
    try {
      await this.session.flush()
    } catch (error) {
      if (!isTeardown(error)) throw error
    }
    await this.session.dispose()
    this.options.exit(code)
  }

  /** The Agent this surface answers for. */
  private get agent(): Agent {
    return this.session.agent
  }

  /**
   * Subscribe to the session's durable events, live stream, and status.
   * @param session - the session to observe.
   */
  private attach(session: TuiSession): void {
    const owned = session.agent
    this.disposers.push(this.options.ctx.on('session/event', (source: Session, event: SessionEvent) => {
      if (source !== session.session) return
      // Every appended event can move a footer fact, including the ones the
      // transcript does not show.
      this.transcript.applyEvent(event)
      this.refresh()
    }))
    this.disposers.push(this.options.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (agent !== owned) return
      if (this.transcript.applyFrame(frame)) this.refresh()
    }))
    this.disposers.push(this.options.ctx.on('agent/status', ({ agent }) => {
      if (agent === owned) this.refresh()
    }))
    this.disposers.push(installApprovalAnswerer(this.options.ctx, this, owned))
    this.disposers.push(installQuestionAnswerer(this.options.ctx, this, owned))
  }

  /** Install the global key bindings; the viewport owns scrolling keys. */
  private registerKeys(): void {
    this.disposers.push(this.tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl('c'))) {
        // A focused prompt owns Ctrl+C as its own cancel gesture.
        if (this.promptActive) return undefined
        if (this.session.running) {
          this.session.cancel()
          this.notice('info', 'cancelling the current turn')
          return { consume: true }
        }
        void this.stop(0)
        return { consume: true }
      }
      if (matchesKey(data, Key.ctrl('d'))) {
        if (this.promptActive) return undefined
        void this.stop(0)
        return { consume: true }
      }
      if (matchesKey(data, Key.ctrl('l'))) {
        this.tui.requestRender(true)
        return { consume: true }
      }
      return undefined
    }))
  }

  /**
   * Route one composer submission.
   * @param text - the submitted text.
   */
  private submit(text: string): void {
    const value = text.trim()
    if (value === '') return
    this.editor.addToHistory(value)
    this.editor.setText('')
    const parsed = parseCommand(value)
    if (parsed !== undefined) {
      void this.runCommand(parsed.name, parsed.input, value).catch((error: unknown) => {
        this.notice('error', error instanceof Error ? error.message : String(error))
      })
      return
    }
    if (this.session.running) this.session.steer(value)
    else this.session.submit(value)
    this.refresh()
  }

  /**
   * Run one slash line: an app command, or a registry command against the Agent.
   * @param name - the command name without the slash.
   * @param input - the trailing input.
   * @param line - the original line, forwarded to the registry unchanged.
   */
  private async runCommand(name: string, input: string, line: string): Promise<void> {
    switch (name) {
      case 'help':
        this.notice('info', this.helpText())
        return
      case 'quit':
        await this.stop(0)
        return
      case 'new':
        await this.replaceSession(() => TuiSession.create(this.options.ctx, this.sessionOptions()))
        this.notice('info', 'started a new session')
        return
      case 'sessions':
        await this.listSessions()
        return
      case 'resume':
        await this.resumeCommand(input)
        return
      case 'model':
        await this.modelCommand(input)
        return
      default:
        await this.registryCommand(name, line)
    }
  }

  /** Invocation-derived session options. */
  private sessionOptions(): TuiSessionOptions {
    return {
      cwd: this.options.cwd,
      provider: this.options.invocation.provider,
      model: this.options.invocation.model,
    }
  }

  /**
   * Execute one registry command and render its settled result.
   * @param name - the command name without the slash.
   * @param line - the original line.
   */
  private async registryCommand(name: string, line: string): Promise<void> {
    const controller = new AbortController()
    const execution = await executeCommand(this.options.ctx, this.agent, line, controller.signal)
    if (execution === undefined) {
      this.notice('error', `unknown command: /${name} (try /help)`)
      return
    }
    const result = execution.result
    if (result.kind === 'success') this.notice('info', result.text ?? `/${name} completed`)
    else this.notice('error', result.text)
    this.refresh()
  }

  /** The `/help` body: app commands followed by registry commands. */
  private helpText(): string {
    const items = commandCatalog(this.options.ctx, this.agent)
    const width = Math.max(...items.map(item => item.value.length))
    return items
      .map(item => `${item.value.padEnd(width)}  ${item.description ?? ''}`)
      .join('\n')
  }

  /** List stored sessions, newest first. */
  private async listSessions(): Promise<void> {
    const persistence = this.options.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      this.notice('error', 'this deployment stores no sessions')
      return
    }
    const snapshots = await persistence.list()
    if (snapshots.length === 0) {
      this.notice('info', 'no stored sessions')
      return
    }
    const lines = [...snapshots]
      .sort((left, right) => right.header.createdAt - left.header.createdAt)
      .slice(0, SESSION_LIST_LIMIT)
      .map(snapshot => describeSession(snapshot.header))
    this.notice('info', lines.join('\n'))
  }

  /**
   * Resume a stored session named by input, or chosen from a picker.
   * @param input - the trailing `/resume` input.
   */
  private async resumeCommand(input: string): Promise<void> {
    const trimmed = input.trim()
    if (trimmed !== '') {
      await this.replaceSession(() => TuiSession.resume(this.options.ctx, trimmed, this.sessionOptions()))
      this.notice('info', `resumed ${trimmed}`)
      return
    }
    const persistence = this.options.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      this.notice('error', 'usage: /resume <session-id>')
      return
    }
    const snapshots = [...await persistence.list()]
      .sort((left, right) => right.header.createdAt - left.header.createdAt)
      .slice(0, SESSION_LIST_LIMIT)
    if (snapshots.length === 0) {
      this.notice('info', 'no stored sessions')
      return
    }
    const items: SelectItem[] = snapshots.map(snapshot => ({
      value: snapshot.header.id,
      label: shortId(snapshot.header.id),
      description: describeSession(snapshot.header),
    }))
    const chosen = await this.choose('Resume which session?', items)
    if (chosen === undefined) return
    await this.replaceSession(() => TuiSession.resume(this.options.ctx, chosen.value, this.sessionOptions()))
    this.notice('info', `resumed ${chosen.value}`)
  }

  /**
   * Show or switch the model route.
   * @param input - the trailing `/model` input.
   */
  private async modelCommand(input: string): Promise<void> {
    const trimmed = input.trim()
    if (trimmed === '') {
      const choices = await listModelChoices(this.options.ctx)
      if (choices.length === 0) {
        this.notice('error', 'no model route is registered')
        return
      }
      const items: SelectItem[] = choices.map(choice => ({
        value: `${choice.provider}/${choice.model}`,
        label: choice.label,
        description: choice.description,
      }))
      const chosen = await this.choose('Select a model', items)
      if (chosen === undefined) return
      this.applyRoute(chosen.value)
      return
    }
    this.applyRoute(trimmed)
  }

  /**
   * Apply a `provider/model` route.
   * @param value - the route text.
   */
  private applyRoute(value: string): void {
    const [provider, model] = splitRoute(value)
    if (provider === undefined || model === undefined) {
      this.notice('error', `expected <provider>/<model>, got ${JSON.stringify(value)}`)
      return
    }
    this.session.selectModel({ provider, model })
    this.notice('info', `model set to ${provider}/${model}`)
    this.refresh()
  }

  /**
   * Swap the live session, rewiring events and clearing the transcript.
   * @param open - creates the replacement session.
   */
  private async replaceSession(open: () => Promise<TuiSession>): Promise<void> {
    const previous = this.session
    for (const dispose of this.disposers.splice(0)) dispose()
    try {
      await previous.flush()
    } catch (error) {
      if (!isTeardown(error)) throw error
    }
    await previous.dispose()
    this.transcript.reset()
    this.session = await open()
    this.attach(this.session)
    this.refresh()
  }

  /** Push the current facts into the footer and request a repaint. */
  private refresh(): void {
    // Teardown restores the terminal; a late event must not repaint it.
    if (this.stopped) return
    const session = this.session
    const route = session.route
    const status: TuiStatus = {
      workspace: this.options.cwd.replace(homedir(), '~'),
      state: session.running ? 'running' : 'idle',
      model: modelLabel(route.provider, route.model, this.providerCount),
      effort: route.reasoningEffort,
      usage: this.transcript.usage,
      context: this.contextStatus(session.session),
    }
    this.statusBar.set(status)
    this.composer.setHint(this.hints())
    this.tui.requestRender()
  }

  /**
   * Context occupancy for the footer, read from the measurement projection.
   *
   * The live Assistant stream repaints far more often than it appends session
   * events, and a projection read folds every registered unit, so the value is
   * cached against the log position it was read at.
   * @param session - the session whose pressure is presented.
   * @returns the occupancy, or undefined while no request has been measured or no capacity is known.
   */
  private contextStatus(session: Session): TuiContextStatus | undefined {
    const cached = this.contextCache
    if (cached !== undefined && cached.seq === session.seq) return cached.value
    const pressure = this.measurePressure(session)
    const window = pressure?.contextWindow
    const tokens = pressure?.projectedTokens ?? pressure?.pressureTokens
    const value = window === undefined || tokens === undefined
      ? undefined
      : { tokens, window, automatic: this.autoCompaction }
    this.contextCache = { seq: session.seq, value }
    return value
  }

  private measurePressure(session: Session): ContextPressureProjection | undefined {
    const projections = this.options.ctx.get('sessionProjections')
    if (projections === undefined) return undefined
    return projections.snapshot(session, ['contextPressure']).values['contextPressure']
  }

  /** The placeholder the empty composer shows: the keys valid in the current state. */
  private hints(): string {
    const parts: string[] = [this.session.running ? 'Enter steer' : 'Enter send']
    if (this.session.running) parts.push('Ctrl+C cancel')
    if (this.viewport !== undefined) parts.push('PgUp/PgDn scroll')
    parts.push('/help commands', 'Ctrl+D quit')
    if (this.viewport !== undefined && !this.viewport.isFollowingOutput) parts.push('scrolled up')
    if (this.options.config.screen === 'inline') parts.push('inline screen')
    return parts.join(' · ')
  }

  /** Append one notice row and repaint. */
  private notice(level: 'info' | 'error', text: string): void {
    this.transcript.notice(level, text)
    this.refresh()
  }

  /**
   * Ask the user to choose one item through a modal list.
   * @param title - the question shown above the list.
   * @param items - the selectable items.
   * @param signal - cancellation lifetime; aborting dismisses the prompt.
   * @returns the chosen item, or undefined when dismissed.
   */
  choose(title: string, items: readonly SelectItem[], signal?: AbortSignal): Promise<SelectItem | undefined> {
    if (items.length === 0) return Promise.resolve(undefined)
    return this.enqueuePrompt(() => new Promise<SelectItem | undefined>((resolve) => {
      const list = new SelectList([...items], Math.min(items.length, PROMPT_VISIBLE_ITEMS), selectListTheme(this.theme))
      const handle = this.showPrompt(title, list)
      const settle = (item: SelectItem | undefined): void => {
        this.dismissPrompt(handle)
        resolve(item)
      }
      list.onSelect = (item) => { settle(item) }
      list.onCancel = () => { settle(undefined) }
      signal?.addEventListener('abort', () => { settle(undefined) }, { once: true })
    }))
  }

  /**
   * Ask the user for one line of text through a modal input.
   * @param title - the question shown above the input.
   * @param signal - cancellation lifetime; aborting dismisses the prompt.
   * @returns the entered text, or undefined when dismissed.
   */
  ask(title: string, signal?: AbortSignal): Promise<string | undefined> {
    return this.enqueuePrompt(() => new Promise<string | undefined>((resolve) => {
      const input = new Input()
      const handle = this.showPrompt(title, input)
      const settle = (value: string | undefined): void => {
        this.dismissPrompt(handle)
        resolve(value)
      }
      input.onSubmit = (value) => { settle(value) }
      input.onEscape = () => { settle(undefined) }
      signal?.addEventListener('abort', () => { settle(undefined) }, { once: true })
    }))
  }

  /**
   * Serialize modal prompts: only one may own the keyboard at a time.
   * @param run - the prompt to run when its turn arrives.
   * @returns the prompt's result.
   */
  private enqueuePrompt<T>(run: () => Promise<T>): Promise<T> {
    const next = this.promptChain.then(run, run)
    this.promptChain = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * Show one modal over the transcript.
   * @param title - the heading line.
   * @param body - the component that owns input while the modal is up.
   * @returns the overlay handle.
   */
  private showPrompt(title: string, body: SelectList | Input): OverlayHandle {
    const width = Math.max(24, Math.min(76, this.tui.terminal.columns - 6))
    const height = Math.max(5, Math.min(18, this.tui.terminal.rows - 4))
    const handle = this.tui.showOverlay(new PromptPanel(title, this.theme, body), {
      width,
      maxHeight: height,
      anchor: 'center',
      margin: 1,
    })
    this.promptActive = true
    this.editor.disableSubmit = true
    return handle
  }

  /**
   * Close one modal and give the keyboard back to the composer.
   * @param handle - the overlay handle returned by {@link showPrompt}.
   */
  private dismissPrompt(handle: OverlayHandle): void {
    handle.hide()
    this.promptActive = false
    this.editor.disableSubmit = false
    this.tui.setFocus(this.composer)
    this.refresh()
  }

  /** Restore the terminal exactly once. */
  private teardown(): void {
    if (this.stopped) return
    this.stopped = true
    for (const dispose of this.disposers.splice(0)) dispose()
    this.tui.stop()
  }
}

/**
 * Split a `provider/model` route.
 * @param value - the route text.
 * @returns the two halves, or undefineds when the text is not a route.
 */
function splitRoute(value: string): [string | undefined, string | undefined] {
  const index = value.indexOf('/')
  if (index <= 0 || index === value.length - 1) return [undefined, undefined]
  return [value.slice(0, index), value.slice(index + 1)]
}

/**
 * Short display form of a session id.
 * @param id - the full session id.
 * @returns the trailing identity segment.
 */
function shortId(id: string): string {
  return id.length <= 12 ? id : id.slice(-12)
}

/**
 * One stored-session line for the picker and `/sessions`.
 * @param header - the stored session header.
 * @returns `id  created  workspace`.
 */
function describeSession(header: { id: string; createdAt: number; cwd?: string }): string {
  const created = new Date(header.createdAt).toISOString().replace('T', ' ').slice(0, 16)
  return `${shortId(header.id)}  ${created}  ${header.cwd ?? '(no workspace)'}`
}
