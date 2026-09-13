/**
 * The interactive terminal application: builds the pi-tui surface, owns the one
 * session it drives, routes composer input to local commands, the command
 * registry, or the Agent, and restores the terminal on exit.
 * @module @deepseek-ai/dsh-tui-app/app
 */

import { Buffer } from 'node:buffer'
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
  isKeyRelease,
  matchesKey,
} from '@earendil-works/pi-tui'
import type { Component, OverlayHandle, SelectItem, SelectListLayoutOptions, TUI, Terminal } from '@earendil-works/pi-tui'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Empty type import carries the optional attachment service read by image paste.
import type {} from '@deepseek-ai/dsh-attachment'
// Empty type import carries the optional persistence read used by `/resume`.
import type {} from '@deepseek-ai/dsh-session-persistence'
// Empty type import carries the optional compaction policy read used by the footer.
import type {} from '@deepseek-ai/dsh-compaction'
// Empty type import carries the optional plan-mode service read by the mode toggle.
import type {} from '@deepseek-ai/dsh-plan-mode'
// Empty type import carries the optional measurement projection the footer reads.
import type {} from '@deepseek-ai/dsh-session-projection'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ContextPressureProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
// Type-only: activates the `sessionStats` projection key the footer's throughput reads.
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { createTheme, editorTheme, resolveColorScheme, selectListTheme, supportsColor } from './ansi.ts'
import type { TuiTheme } from './ansi.ts'
import { readClipboardImage } from './clipboard.ts'
import type { ClipboardImage } from './clipboard.ts'
import type { Config } from './config.ts'
import { commandCatalog, executeCommand, listEffortChoices, listModelChoices, parseCommand } from './commands.ts'
import { imageMarker, parseImageMarkers } from './images.ts'
import { installApprovalAnswerer, installQuestionAnswerer } from './interactions.ts'
import type { InteractionHost } from './interactions.ts'
import { TuiSession } from './session.ts'
import type { TuiSessionOptions } from './session.ts'
import type { TuiStartupValues } from './startup.ts'
import { createToolPresentationResolver } from './tool-view.ts'
import { DetailBody, PlaceholderEditor, PROMPT_PANEL_CHROME_ROWS, PromptPanel, StatusBar, TranscriptView, modelLabel, promptPanelRows } from './views.ts'
import type { TuiContextStatus, TuiSessionStats, TuiStatus } from './views.ts'
import { Transcript } from './transcript.ts'

/** Longest stored-session list rendered by `/sessions`. */
const SESSION_LIST_LIMIT = 20
/** Selectable items shown at once in a prompt overlay. */
const PROMPT_VISIBLE_ITEMS = 10
/** Rows the alternate-screen layout pins under the transcript: the composer's three and the footer's two. */
const PINNED_FOOTER_ROWS = 5
/**
 * Picker layout whose value column grows to its widest label. The component's
 * default caps that column at 32 columns and shortens the value there, which
 * truncates every fully qualified `provider/model` route; growing it lets the
 * label show in full and yields the description first when space runs out.
 */
const PROMPT_LIST_LAYOUT: SelectListLayoutOptions = {
  minPrimaryColumnWidth: 1,
  maxPrimaryColumnWidth: Number.MAX_SAFE_INTEGER,
}

/** Billing buckets a session without the `tokenUsage` unit is treated as having. */
const ZERO_USAGE: TokenUsageProjection = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

/** Footer facts derived from one projection snapshot, cached against the Session and its log position. */
interface TuiMeasurement {
  /** Context occupancy, absent until the meter reports both a pressure and a capacity. */
  context: TuiContextStatus | undefined
  /** Whole-log throughput and token totals; zero counts render nothing. */
  stats: TuiSessionStats
}

/** Process-facing effects the app needs; tests substitute them. */
export const internals: {
  /** Build the terminal the TUI drives. */
  createTerminal: () => Terminal
  /** Whether this invocation has an interactive terminal. */
  isInteractive: () => boolean
  /** Read one image from the system clipboard, or undefined when it holds none. */
  readClipboardImage: () => Promise<ClipboardImage | undefined>
  /** Sink for boot failures the app cannot report through the UI. */
  stderr: { write(chunk: string): unknown }
} = {
  createTerminal: () => new ProcessTerminal(),
  isInteractive: () => process.stdin.isTTY && process.stdout.isTTY,
  readClipboardImage: () => readClipboardImage(),
  stderr: process.stderr,
}

/** One clipboard image the composer holds under its marker number. */
interface PendingImage extends ClipboardImage {
  /** Marker number the composer shows for this image. */
  index: number
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
  private readonly transcript: Transcript
  private readonly transcriptView: TranscriptView
  private readonly statusBar: StatusBar
  private readonly editor: Editor
  private readonly composer: PlaceholderEditor
  private readonly disposers: (() => void)[] = []
  /** Subscriptions to the current session; `/new` and `/resume` replace them wholesale. */
  private readonly sessionDisposers: (() => void)[] = []
  private session: TuiSession
  private leaving = false
  private stopped = false
  private promptActive = false
  private promptChain: Promise<unknown> = Promise.resolve()
  /** Clipboard images the composer holds, by the marker number the draft shows. */
  private readonly pendingImages = new Map<number, PendingImage>()
  /** Whether this host's terminal claims Ctrl+V, so image paste belongs on Alt+V. */
  private readonly altPaste = reservesCtrlV(process.platform, process.env)
  /** Providers the deployment registered; more than one qualifies the footer's model label. */
  private readonly providerCount: number
  /** Whether the mounted compaction engine schedules its own work. */
  private readonly autoCompaction: boolean
  /** Footer measurement cached against the session and log position it was read at. */
  private measurementCache: { session: Session; seq: number; value: TuiMeasurement } | undefined

  private constructor(
    private readonly options: TuiAppOptions,
    session: TuiSession,
    terminal: Terminal,
  ) {
    this.session = session
    this.theme = createTheme({
      enabled: supportsColor(process.env, process.stdout.isTTY),
      palette: resolveColorScheme(options.config.colorScheme, process.env),
    })
    this.transcript = new Transcript(createToolPresentationResolver(options.ctx, () => this.session.agent))
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
    this.sessionDisposers.push(this.options.ctx.on('session/event', (source: Session, event: SessionEvent) => {
      if (source !== session.session) return
      // Every appended event can move a footer fact, including the ones the
      // transcript does not show.
      this.transcript.applyEvent(event)
      this.refresh()
    }))
    this.sessionDisposers.push(this.options.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (agent !== owned) return
      if (this.transcript.applyFrame(frame)) this.refresh()
    }))
    this.sessionDisposers.push(this.options.ctx.on('agent/status', ({ agent }) => {
      if (agent === owned) this.refresh()
    }))
    this.sessionDisposers.push(installApprovalAnswerer(this.options.ctx, this, owned))
    this.sessionDisposers.push(installQuestionAnswerer(this.options.ctx, this, owned))
  }

  /** Install the global key bindings; the viewport owns scrolling keys. */
  private registerKeys(): void {
    this.disposers.push(this.tui.addInputListener((data) => {
      // A terminal reporting the kitty keyboard protocol sends a release event
      // after the press for one keystroke. The renderer drops that release only
      // after this listener chain, so a binding that did not would run twice.
      if (isKeyRelease(data)) return undefined
      // Windows terminals keep Ctrl+V for their own paste, so the surface binds
      // the same action to Alt+V there.
      if (matchesKey(data, Key.ctrl('v')) || (this.altPaste && matchesKey(data, Key.alt('v')))) {
        if (this.promptActive) return undefined
        void this.pasteClipboardImage()
        return { consume: true }
      }
      if (matchesKey(data, Key.ctrl('c'))) {
        // A focused prompt owns Ctrl+C as its own cancel gesture.
        if (this.promptActive) return undefined
        if (this.session.running) {
          this.interrupt()
          return { consume: true }
        }
        void this.stop(0)
        return { consume: true }
      }
      if (matchesKey(data, Key.escape)) {
        // A focused prompt owns Escape as its own cancel gesture, and the
        // alternate-screen viewport consumes it first while a transcript
        // search is open.
        if (this.promptActive) return undefined
        if (this.session.running) {
          this.interrupt()
          return { consume: true }
        }
        return undefined
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
      if (matchesKey(data, Key.shift('tab'))) {
        // A focused prompt owns Shift+Tab as it owns Ctrl+C.
        if (this.promptActive) return undefined
        this.togglePlanMode()
        return { consume: true }
      }
      return undefined
    }))
  }

  /**
   * Flip plan mode for this session's Agent.
   *
   * The service commits the change immediately between turns and holds it until
   * the next accepted in-turn pre-step while a turn is open, so the notice
   * distinguishes the two.
   */
  private togglePlanMode(): void {
    const planMode = this.options.ctx.get('planMode')
    if (planMode === undefined) {
      this.notice('error', 'this deployment mounts no plan mode')
      return
    }
    const current = planMode.get(this.agent)
    const target = !(current.pending ?? current.active)
    const outcome = planMode.set(this.agent, target)
    this.notice('info', outcome === 'queued'
      ? (target ? 'entering plan mode from the next step' : 'leaving plan mode from the next step')
      : (target ? 'plan mode on · Shift+Tab to leave' : 'plan mode off'))
  }

  /**
   * Abort the running turn and report the interruption.
   *
   * The Agent's lifecycle status stays `running` until the turn settles, so the
   * notice is the immediate acknowledgement that the interrupt landed.
   */
  private interrupt(): void {
    this.session.cancel()
    this.notice('info', 'cancelling the current turn')
  }

  /**
   * Route one composer submission.
   *
   * A line citing images the composer holds becomes a prompt carrying those
   * images; every other line runs a command or reaches the Agent as text.
   * @param text - the submitted text.
   */
  private submit(text: string): void {
    const value = text.trim()
    if (value === '') return
    const marked = parseImageMarkers(value, new Set(this.pendingImages.keys()))
    const images = marked.indices.flatMap((index) => {
      const image = this.pendingImages.get(index)
      return image === undefined ? [] : [image]
    })
    const prompt = marked.text.trim()
    if (prompt !== '') this.editor.addToHistory(prompt)
    this.editor.setText('')
    if (images.length === 0) {
      this.runLine(value)
      return
    }
    // The markers name images this draft owns; this submission consumes them.
    this.pendingImages.clear()
    this.sendImages(prompt, images).catch((error: unknown) => {
      this.restoreDraft(value, images)
      this.notice('error', error instanceof Error ? error.message : String(error))
    })
  }

  /**
   * Run one composer line that carries no image: an app command, a registry
   * command, or the Agent's next prompt.
   * @param value - the trimmed line.
   */
  private runLine(value: string): void {
    const parsed = parseCommand(value)
    if (parsed !== undefined) {
      void this.runCommand(parsed.name, parsed.input, value).catch((error: unknown) => {
        this.notice('error', error instanceof Error ? error.message : String(error))
      })
      return
    }
    const content: ContentBlock[] = [{ type: 'text', text: value }]
    if (this.session.running) this.session.steer(content)
    else this.session.submit(content)
    this.refresh()
  }

  /**
   * Attach one clipboard image to the composing draft.
   *
   * The bytes stay in memory until the submission citing the marker admits them
   * to the durable attachment store, so a draft that never submits writes
   * nothing.
   */
  private async pasteClipboardImage(): Promise<void> {
    const image = await internals.readClipboardImage()
    if (this.stopped) return
    if (image === undefined) {
      this.notice('error', 'no image on the clipboard')
      return
    }
    const index = Math.max(0, ...this.pendingImages.keys()) + 1
    this.pendingImages.set(index, { ...image, index })
    this.editor.insertTextAtCursor(`${imageMarker(index)} `)
    this.refresh()
  }

  /**
   * Admit one prompt's images and hand the Agent the text and durable references.
   * @param text - the model-visible prompt text; empty for an image-only prompt.
   * @param images - the prompt's images, in content order.
   * @throws when the deployment stores no attachments, the routed model refuses images, or admission fails.
   */
  private async sendImages(text: string, images: readonly PendingImage[]): Promise<void> {
    const attachments = this.options.ctx.get('attachments')
    if (attachments === undefined) throw new Error('this deployment stores no attachments')
    const route = this.session.route
    const model = await this.options.ctx.llm.resolveModelInfo(route.provider, route.model)
    if (model.inputModalities !== undefined && !model.inputModalities.includes('image')) {
      throw new Error(`model "${route.model}" does not accept image input`)
    }
    const admitted = await attachments.admitPromptContent([
      ...(text === '' ? [] : [{ type: 'text' as const, text }]),
      ...images.map(image => ({
        type: 'image' as const,
        mediaType: image.mediaType,
        data: Buffer.from(image.data).toString('base64'),
      })),
    ])
    const content: ContentBlock[] = admitted.map((part) => {
      switch (part.type) {
        case 'text': return { type: 'text', text: part.text }
        case 'image': return { type: 'image', attachment: part.attachment }
        case 'file': return { type: 'file', attachment: part.attachment }
        /* v8 ignore next -- closed-union exhaustiveness guard */
        default: return assertNever(part, 'admitted prompt content')
      }
    })
    if (this.session.running) this.session.steer(content)
    else this.session.submit(content)
    this.refresh()
  }

  /**
   * Put a refused submission back into the composer without discarding what the
   * user typed while its images were being admitted.
   * @param text - the refused line, markers included.
   * @param images - the images the line cites.
   */
  private restoreDraft(text: string, images: readonly PendingImage[]): void {
    for (const image of images) this.pendingImages.set(image.index, image)
    this.editor.insertTextAtCursor(text)
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
      case 'effort':
        await this.effortCommand(input)
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
    // The new route's own default effort applies, so a previous route's
    // explicit effort never rides into a model that does not accept it.
    this.session.selectModel({ provider, model })
    this.notice('info', `model set to ${provider}/${model}`)
    this.refresh()
  }

  /**
   * Show or switch the reasoning effort of the routed model.
   * @param input - the trailing `/effort` input.
   */
  private async effortCommand(input: string): Promise<void> {
    const route = this.session.route
    const choices = await listEffortChoices(this.options.ctx, route)
    if (choices === undefined) {
      this.notice('error', `${route.provider}/${route.model} declares no reasoning effort`)
      return
    }
    const trimmed = input.trim()
    if (trimmed !== '') {
      const requested = choices.find(choice => choice.effort !== undefined && String(choice.effort) === trimmed)
      if (requested === undefined) {
        const ids = choices.flatMap(choice => choice.effort === undefined ? [] : [String(choice.effort)])
        this.notice('error', `expected one of ${ids.join(', ')}, got ${JSON.stringify(trimmed)}`)
        return
      }
      this.applyEffort(requested.effort)
      return
    }
    const chosen = await this.choose('Select reasoning effort', choices.map(choice => ({
      value: choice.effort === undefined ? '' : String(choice.effort),
      label: choice.label,
      description: choice.description,
    })))
    if (chosen === undefined) return
    this.applyEffort(chosen.value === '' ? undefined : ReasoningEffortId(chosen.value))
  }

  /**
   * Apply one reasoning effort to the route in force.
   * @param effort - the selected effort, or undefined to send none and let the provider decide.
   */
  private applyEffort(effort: ReasoningEffortId | undefined): void {
    const route = this.session.route
    this.session.selectModel({
      provider: route.provider,
      model: route.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    })
    this.notice('info', `reasoning effort set to ${effort === undefined ? 'the provider default' : effort}`)
    this.refresh()
  }

  /**
   * Swap the live session, rewiring events and clearing the transcript.
   * @param open - creates the replacement session.
   */
  private async replaceSession(open: () => Promise<TuiSession>): Promise<void> {
    const previous = this.session
    // Only the session subscriptions retire with the old session; the global
    // key bindings stay installed for the replacement.
    for (const dispose of this.sessionDisposers.splice(0)) dispose()
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
    const plan = this.planStatus()
    const measured = this.measurement(session.session)
    const status: TuiStatus = {
      workspace: this.options.cwd.replace(homedir(), '~'),
      state: session.running ? 'running' : 'idle',
      model: modelLabel(route.provider, route.model, this.providerCount),
      effort: route.reasoningEffort,
      usage: this.transcript.usage,
      context: measured.context,
      stats: measured.stats,
      plan,
    }
    this.statusBar.set(status)
    this.composer.setHint(this.hints(plan !== undefined))
    this.tui.requestRender()
  }

  /**
   * Whether plan mode is in force, or selected to apply from the next step.
   *
   * A queued selection changes without appending an event, so this reads the
   * service on every refresh instead of caching against the log position.
   * @returns the effective mode, or undefined when the deployment mounts no plan mode.
   */
  private planStatus(): boolean | undefined {
    const planMode = this.options.ctx.get('planMode')
    if (planMode === undefined) return undefined
    const state = planMode.get(this.agent)
    return state.pending ?? state.active
  }

  /**
   * Footer measurement for one session, read from the projection registry.
   *
   * The live Assistant stream repaints far more often than it appends session
   * events, and a projection read folds every registered unit, so the whole
   * measurement is cached against the Session and log position it was read at —
   * keying on the Session too keeps a replaced session's figures out of the
   * next one.
   * @param session - the session whose footer facts are presented.
   * @returns context occupancy and whole-log token figures for the frame.
   */
  private measurement(session: Session): TuiMeasurement {
    const cached = this.measurementCache
    if (cached !== undefined && cached.session === session && cached.seq === session.seq) return cached.value
    const values = this.options.ctx.get('sessionProjections')
      ?.snapshot(session, ['contextPressure', 'tokenUsage', 'sessionStats']).values
    const pressure: ContextPressureProjection | undefined = values?.['contextPressure']
    const window = pressure?.contextWindow
    const tokens = pressure?.projectedTokens ?? pressure?.pressureTokens
    const usage: TokenUsageProjection = values?.['tokenUsage'] ?? ZERO_USAGE
    const whole: SessionStatsProjection | undefined = values?.['sessionStats']
    const value: TuiMeasurement = {
      context: window === undefined || tokens === undefined
        ? undefined
        : { tokens, window, automatic: this.autoCompaction },
      stats: {
        ...whole !== undefined && whole.decodeMs > 0
          ? { tokensPerSecond: whole.decodeTokens / (whole.decodeMs / 1_000) }
          : {},
        promptTokens: usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
      },
    }
    this.measurementCache = { session, seq: session.seq, value }
    return value
  }

  /**
   * The placeholder the empty composer shows: the keys valid in the current state.
   * @param planAvailable - whether the deployment mounts plan mode.
   */
  private hints(planAvailable: boolean): string {
    const parts: string[] = [this.session.running ? 'Enter steer' : 'Enter send']
    if (planAvailable) parts.push('Shift+Tab plan')
    parts.push(`${this.altPaste ? 'Alt+V' : 'Ctrl+V'} image`)
    if (this.session.running) parts.push('Esc/Ctrl+C cancel')
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
   * @param detail - markdown shown above the list; while it overflows, Up/Down
   * and the wheel scroll it and Left/Right move the list selection. A detail
   * gives the panel every row above the pinned footer instead of the picker's cap.
   * @returns the chosen item, or undefined when dismissed.
   */
  choose(title: string, items: readonly SelectItem[], signal?: AbortSignal, detail?: string): Promise<SelectItem | undefined> {
    if (items.length === 0) return Promise.resolve(undefined)
    return this.enqueuePrompt(() => new Promise<SelectItem | undefined>((resolve) => {
      const detailed = detail !== undefined
      const capacity = this.promptRows(detailed) - PROMPT_PANEL_CHROME_ROWS
      // A list longer than the panel budget scrolls, and the scroll indicator
      // spends one of the body rows the panel has.
      const scrolling = items.length > capacity
      const visible = Math.max(1, Math.min(items.length, PROMPT_VISIBLE_ITEMS, capacity - (scrolling ? 1 : 0)))
      const list = new SelectList([...items], visible, selectListTheme(this.theme), PROMPT_LIST_LAYOUT)
      // A long detail owns Up/Down, so the picker's selection needs a tracked
      // index for the Left/Right and Tab keys DetailBody hands over.
      let selected = 0
      list.onSelectionChange = (item) => {
        selected = items.findIndex(candidate => candidate.value === item.value)
      }
      const step = (delta: -1 | 1): void => {
        selected = (selected + delta + items.length) % items.length
        list.setSelectedIndex(selected)
      }
      const body: Component = detail === undefined ? list : new DetailBody(detail, list, this.theme, capacity, step)
      const handle = this.showPrompt(title, body, detailed)
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
   * @param detail - markdown shown above the input; Up/Down, PageUp/PageDown,
   * and the wheel scroll it while it overflows. A detail gives the panel every
   * row above the pinned footer instead of the picker's cap.
   * @returns the entered text, or undefined when dismissed.
   */
  ask(title: string, signal?: AbortSignal, detail?: string): Promise<string | undefined> {
    return this.enqueuePrompt(() => new Promise<string | undefined>((resolve) => {
      const input = new Input()
      const detailed = detail !== undefined
      const capacity = this.promptRows(detailed) - PROMPT_PANEL_CHROME_ROWS
      const handle = this.showPrompt(title, detail === undefined ? input : new DetailBody(detail, input, this.theme, capacity), detailed)
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
   *
   * The alternate-screen layout pins the composer and the footer, so the panel
   * is anchored directly above them and reads as the transcript's next lines;
   * the inline layout has no fixed footer position, so the panel is centered.
   * @param title - the heading line.
   * @param body - the component that owns input while the modal is up.
   * @param detailed - whether the body carries scrollable detail, which lets the
   * panel take every row above the pinned footer instead of the picker's cap.
   * @returns the overlay handle.
   */
  private showPrompt(title: string, body: Component, detailed: boolean): OverlayHandle {
    const place = this.viewport === undefined
      ? { anchor: 'center' as const }
      : { anchor: 'bottom-center' as const, margin: { bottom: PINNED_FOOTER_ROWS } }
    const handle = this.tui.showOverlay(new PromptPanel(title, this.theme, body), {
      width: '100%',
      maxHeight: this.promptRows(detailed),
      ...place,
    })
    this.promptActive = true
    this.editor.disableSubmit = true
    return handle
  }

  /**
   * Rows one prompt panel may occupy above the pinned footer.
   * @param detailed - whether the panel carries scrollable detail, which may
   * take every row above the footer rather than the picker's cap.
   * @returns the panel's row budget.
   */
  private promptRows(detailed: boolean): number {
    const reserved = this.viewport === undefined ? 0 : PINNED_FOOTER_ROWS
    return promptPanelRows(this.tui.terminal.rows - reserved, detailed)
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
    for (const dispose of this.sessionDisposers.splice(0)) dispose()
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
 * Whether this host's terminals claim Ctrl+V for their own paste.
 *
 * Windows consoles and WSL distribute Ctrl+V to the terminal's paste, so the
 * surface binds image paste to Alt+V there.
 * @param platform - the platform the surface runs on.
 * @param env - the process environment.
 * @returns whether the alternate paste key governs this host.
 */
export function reservesCtrlV(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  return platform === 'win32' || env.WSL_DISTRO_NAME !== undefined
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
