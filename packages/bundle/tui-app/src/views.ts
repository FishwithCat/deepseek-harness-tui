/**
 * pi-tui components for the terminal surface: the transcript document, the
 * pinned status bar, and the formatting helpers they share. Every rendered line
 * is truncated to the viewport width because the renderer treats an over-wide
 * line as a component defect.
 * @module @deepseek-ai/dsh-tui-app/views
 */

import { CURSOR_MARKER, Key, Markdown, isFocusable, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type { Component, Editor, Focusable, MarkdownTheme } from '@earendil-works/pi-tui'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { markdownTheme } from './ansi.ts'
import type { TuiTheme } from './ansi.ts'
import type { ToolEntry, TranscriptEntry, UserEntry } from './transcript.ts'
import { Transcript } from './transcript.ts'

/** Indent applied to a Tool row's result body. */
const TOOL_BODY_INDENT = '    '
/** Result lines shown before the row is folded. */
const TOOL_RESULT_MAX_LINES = 12
/** Longest Tool argument summary kept on the heading line. */
const TOOL_SUMMARY_MAX_CHARS = 96
/** Argument keys worth showing alone, in preference order. */
const TOOL_SUMMARY_KEYS = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'prompt', 'description', 'name']

/**
 * Collapse text to a single terminal line.
 *
 * A transcript row owns exactly one terminal row, so a Tool argument carrying
 * newlines, tabs, or escape sequences must not reach a heading verbatim: the
 * terminal would print the embedded breaks and spill the row into the pinned
 * footer. Control characters become spaces; nothing else changes.
 * @param text - the text to flatten.
 * @returns the same text on one line.
 */
function singleLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ')
}

/**
 * One-line account of a Tool call's arguments.
 * @param args - the raw arguments JSON string.
 * @returns a short, human-readable summary on one line.
 */
export function summarizeToolArguments(args: string): string {
  const trimmed = args.trim()
  if (trimmed === '') return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as unknown
  } catch {
    // The model produced arguments the Tool will reject; show them verbatim.
    return singleLine(trimmed)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return singleLine(trimmed)
  const record = parsed as Record<string, unknown>
  for (const key of TOOL_SUMMARY_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return singleLine(`${key}=${value}`)
  }
  const pairs = Object.entries(record).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
  return pairs.length === 0 ? '' : singleLine(pairs.join(' '))
}

/**
 * Word-wrap text to the viewport width, preserving embedded newlines.
 * @param text - the text to wrap.
 * @param width - the viewport width.
 * @returns wrapped lines.
 */
function wrap(text: string, width: number): string[] {
  const effective = Math.max(1, width)
  return text.split('\n').flatMap(line => wrapTextWithAnsi(line, effective))
}

/**
 * Prefix each wrapped line of a message body.
 * @param text - the body text.
 * @param width - the viewport width.
 * @param first - prefix for the first line.
 * @param rest - prefix for every later line.
 * @returns the prefixed lines.
 */
function prefixBody(text: string, width: number, first: string, rest: string): string[] {
  const prefixWidth = visibleWidth(first)
  return wrap(text, Math.max(1, width - prefixWidth)).map((line, index) => (index === 0 ? first : rest) + line)
}

/**
 * One prompt row's visible body: the markers of its attached images, then its text.
 * @param entry - the prompt row.
 * @returns the row's body on one logical line.
 */
function promptText(entry: UserEntry): string {
  return [...entry.images, entry.text].filter(part => part !== '').join(' ')
}

/**
 * Fold a Tool result body to a bounded number of lines.
 * @param text - the result text.
 * @param width - the viewport width.
 * @returns the indented body lines.
 */
function toolBody(text: string, width: number): string[] {
  const bodyWidth = Math.max(1, width - TOOL_BODY_INDENT.length)
  const lines = wrap(text, bodyWidth)
  if (lines.length <= TOOL_RESULT_MAX_LINES) return lines.map(line => TOOL_BODY_INDENT + line)
  const shown = lines.slice(0, TOOL_RESULT_MAX_LINES).map(line => TOOL_BODY_INDENT + line)
  shown.push(TOOL_BODY_INDENT + `… ${String(lines.length - TOOL_RESULT_MAX_LINES)} more lines`)
  return shown
}

/**
 * The transcript document. It renders every row it holds; the surrounding
 * viewport (an alternate-screen scroll view, or the terminal's own scrollback)
 * owns scrolling.
 */
export class TranscriptView implements Component {
  private cache: { width: number; revision: number; lines: string[] } | undefined
  private readonly markdown = new Map<number, { text: string; component: Markdown }>()
  private readonly markdownTheme: MarkdownTheme

  /**
   * @param transcript - the model this view renders.
   * @param theme - the surface theme.
   */
  constructor(
    private readonly transcript: Transcript,
    private readonly theme: TuiTheme,
  ) {
    this.markdownTheme = markdownTheme(theme)
  }

  /** Drop cached render state. */
  invalidate(): void {
    this.cache = undefined
    this.markdown.clear()
  }

  /**
   * Render the transcript body.
   * @param width - the viewport width in columns.
   * @returns one string per row, each within `width`.
   */
  render(width: number): string[] {
    if (this.cache !== undefined && this.cache.width === width && this.cache.revision === this.transcript.revision) {
      return this.cache.lines
    }
    const lines: string[] = []
    for (const entry of this.transcript.entries()) {
      const row = this.renderEntry(entry, width)
      if (row.length === 0) continue
      if (lines.length > 0) lines.push('')
      lines.push(...row)
    }
    const bounded = lines.map(line => (visibleWidth(line) > width ? truncateToWidth(line, width) : line))
    this.cache = { width, revision: this.transcript.revision, lines: bounded }
    return bounded
  }

  private renderEntry(entry: TranscriptEntry, width: number): string[] {
    switch (entry.kind) {
      case 'user':
        return prefixBody(promptText(entry), width, this.theme.user('› '), '  ')
      case 'assistant': {
        const body = this.assistantMarkdown(entry.id, entry.text, width)
        if (!entry.interrupted) return body
        return [...body, ...prefixBody('[cancelled]', width, this.theme.dim('  '), '  ')]
      }
      case 'reasoning':
        return prefixBody(entry.text, width, this.theme.reasoning('✻ '), this.theme.reasoning('  '))
      case 'tool':
        return this.toolLines(entry, width)
      case 'notice':
        return prefixBody(
          entry.text,
          width,
          entry.level === 'error' ? this.theme.error('! ') : this.theme.notice('· '),
          '  ',
        )
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return []
    }
  }

  private assistantMarkdown(id: number, text: string, width: number): string[] {
    const cached = this.markdown.get(id)
    if (cached === undefined) {
      const component = new Markdown(text, 0, 0, this.markdownTheme, { color: this.theme.assistant })
      this.markdown.set(id, { text, component })
      return component.render(width)
    }
    if (cached.text !== text) {
      cached.text = text
      cached.component.setText(text)
    }
    return cached.component.render(width)
  }

  private toolLines(entry: ToolEntry, width: number): string[] {
    const summary = truncateToWidth(summarizeToolArguments(entry.args), TOOL_SUMMARY_MAX_CHARS, '…')
    const marker = entry.status === 'running' ? '⏺' : entry.status === 'ok' ? '✔' : '✘'
    const style = entry.status === 'running'
      ? this.theme.tool
      : entry.status === 'ok' ? this.theme.toolOk : this.theme.toolError
    const heading = `${style(marker)} ${this.theme.bold(singleLine(entry.name))}${summary === '' ? '' : this.theme.dim(`(${summary})`)}`
    const lines = [truncateToWidth(heading, width)]
    if (entry.error !== undefined) lines.push(...prefixBody(entry.error, width, this.theme.error('  '), '  '))
    if (entry.result !== '') lines.push(...toolBody(entry.result, width))
    return lines
  }
}

/** Tallest prompt panel, so a long picker does not fill a tall terminal. */
const PROMPT_PANEL_MAX_ROWS = 18
/** Rows a prompt spends outside its body: the title and the blank row under it. */
export const PROMPT_PANEL_CHROME_ROWS = 2

/**
 * Row budget for one prompt panel on a terminal with `rows` rows left to it.
 * @param rows - rows available to the panel, excluding any pinned footer.
 * @returns the largest panel height, keeping at least one body row.
 */
export function promptPanelRows(rows: number): number {
  return Math.max(PROMPT_PANEL_CHROME_ROWS + 1, Math.min(PROMPT_PANEL_MAX_ROWS, rows - 2))
}

/** Rows the scroll position line under a detailed prompt spends once its detail overflows. */
const DETAIL_SCROLL_HINT_ROWS = 1

/**
 * A modal body that shows a prompt's supporting detail above its control.
 *
 * `detail` is markdown the caller supplied — a plan under review, or facts a
 * question rests on — and can be taller than the panel. The detail renders in a
 * viewport that yields every row its control does not use; PageUp and PageDown
 * scroll it, while every other key reaches the control, so a picker keeps its
 * own arrow, Enter, and Escape bindings. The control's rendered height, not a
 * fixed split, sizes the viewport, so a two-option review gives the plan nearly
 * the whole panel and a long picker leaves the plan less.
 */
export class DetailBody implements Component {
  private readonly markdown: Markdown
  private scrollTop = 0
  /** Rows the last render gave the detail; also the PageUp/PageDown step. */
  private viewport = 1
  /** Detail rows the last render measured, for clamping a scroll. */
  private content = 0

  /**
   * @param detail - the markdown shown above the control.
   * @param control - the focused control that answers the prompt.
   * @param theme - the surface theme.
   * @param rows - the panel body's row budget, chrome excluded.
   */
  constructor(
    detail: string,
    private readonly control: Component,
    private readonly theme: TuiTheme,
    private readonly rows: number,
  ) {
    this.markdown = new Markdown(detail, 0, 0, markdownTheme(theme))
  }

  /**
   * Scroll the detail, or hand the key to the control.
   * @param data - raw key bytes.
   */
  handleInput(data: string): void {
    if (matchesKey(data, Key.pageUp)) {
      this.scrollTo(this.scrollTop - this.viewport)
      return
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollTo(this.scrollTop + this.viewport)
      return
    }
    if (isFocusable(this.control)) this.control.focused = true
    this.control.handleInput?.(data)
  }

  /** Drop both the detail's and the control's cached render state. */
  invalidate(): void {
    this.markdown.invalidate()
    this.control.invalidate()
  }

  /**
   * Render the detail viewport followed by the control.
   * @param width - the viewport width in columns.
   * @returns the body lines.
   */
  render(width: number): string[] {
    const detail = this.markdown.render(width)
    const control = this.control.render(width)
    const budget = Math.max(0, this.rows - control.length)
    // A control that already spends the whole budget leaves no room for the
    // hint either; the detail is unreachable until the control shrinks.
    const hint = detail.length > budget && budget > DETAIL_SCROLL_HINT_ROWS
    this.viewport = Math.max(0, budget - (hint ? DETAIL_SCROLL_HINT_ROWS : 0))
    this.content = detail.length
    this.scrollTop = clampScroll(this.scrollTop, detail.length, this.viewport)
    const lines = detail.slice(this.scrollTop, this.scrollTop + this.viewport)
    if (hint) {
      const end = this.scrollTop + this.viewport
      lines.push(this.theme.dim(`  ${String(this.scrollTop + 1)}–${String(end)}/${String(detail.length)} · PgUp/PgDn`))
    }
    lines.push(...control)
    return lines
  }

  private scrollTo(top: number): void {
    this.scrollTop = clampScroll(top, this.content, this.viewport)
  }
}

/**
 * Clamp a scroll offset to the scrollable rows of a viewport.
 * @param top - the requested first visible row.
 * @param content - total content rows.
 * @param viewport - visible rows.
 * @returns the offset in `[0, max(0, content - viewport)]`.
 */
function clampScroll(top: number, content: number, viewport: number): number {
  return Math.max(0, Math.min(top, Math.max(0, content - viewport)))
}

/**
 * A modal panel: a title, a blank row, and the control that handles keys. The
 * renderer focuses the component passed to `showOverlay`, and a bare container
 * does not forward keys, so the panel is the focused component.
 *
 * The panel reads as ordinary output rather than a dialog: no border, left
 * aligned like a transcript row. Every row is padded to the width the caller
 * passes, though, because the renderer composites an overlay over the row it
 * covers and leaves the rest of that row as the transcript printed it; padding
 * the full row is what keeps the transcript from showing through beside the
 * body, which would read as one garbled line.
 */
export class PromptPanel implements Component, Focusable {
  /** Set by the renderer when this panel owns the keyboard. */
  focused = false

  /**
   * @param title - the heading line.
   * @param theme - the surface theme.
   * @param body - the control that handles keys.
   */
  constructor(
    private readonly title: string,
    private readonly theme: TuiTheme,
    private readonly body: Component,
  ) {}

  /** Forward keyboard input to the wrapped control. */
  handleInput(data: string): void {
    if (isFocusable(this.body)) this.body.focused = true
    this.body.handleInput?.(data)
  }

  /** Drop the wrapped control's cached render state. */
  invalidate(): void {
    this.body.invalidate()
  }

  /**
   * Render the title and body, filling every row the overlay covers.
   * @param width - the viewport width in columns.
   * @returns the panel lines, each exactly `width` columns wide.
   */
  render(width: number): string[] {
    const available = Math.max(1, width)
    const lines = [this.theme.bold(this.title), '', ...this.body.render(available)]
    return lines.map(line => this.row(line, available))
  }

  private row(text: string, available: number): string {
    const clipped = visibleWidth(text) > available ? truncateToWidth(text, available, '…') : text
    return clipped + ' '.repeat(Math.max(0, available - visibleWidth(clipped)))
  }
}

/** Context occupancy the footer reports against the routed model's capacity. */
export interface TuiContextStatus {
  /** Estimated tokens of the next request's prompt. */
  tokens: number
  /** The routed model's context window in tokens. */
  window: number
  /** Whether the mounted engine compacts automatically at this pressure. */
  automatic: boolean
}

/** One frame of the status bar. */
export interface TuiStatus {
  /** Workspace directory, abbreviated against the home directory. */
  workspace: string
  /** Agent lifecycle state. */
  state: 'idle' | 'running'
  /** Display label for the routed model, provider-qualified when the deployment registers several. */
  model: string
  /** Reasoning effort in force, when the route declares one. */
  effort?: string | undefined
  /**
   * Whether plan mode is in force, or selected to apply from the next step;
   * absent when the deployment mounts no plan mode.
   */
  plan?: boolean | undefined
  /** Token accounting for the last provider call. */
  usage?: TokenUsage | undefined
  /** Context occupancy, absent until the meter reports both a pressure and a capacity. */
  context?: TuiContextStatus | undefined
}

/** Fewest columns kept between the stats and the model when both are shown. */
const STATUS_MIN_GAP = 2
/** Share of the context window at which the occupancy figure reads as a warning. */
const STATUS_CONTEXT_WARN = 0.7
/** Share of the context window at which the occupancy figure reads as a failure. */
const STATUS_CONTEXT_ERROR = 0.9

/**
 * Compact token count for the footer.
 * @param count - a token count.
 * @returns whole units below 1000, one decimal below 10000, then whole thousands or millions.
 */
function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${String(Math.round(count / 1000))}k`
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  return `${String(Math.round(count / 1_000_000))}M`
}

/**
 * Display label for the routed model: the provider qualifies it only when the
 * deployment registers several, so the common single-provider footer stays short.
 * @param provider - the routed provider.
 * @param model - the routed model id.
 * @param providerCount - providers the deployment registered.
 * @returns the label the footer's right side shows.
 */
export function modelLabel(provider: string, model: string, providerCount: number): string {
  return providerCount > 1 ? `(${provider}) ${model}` : model
}

/**
 * Format provider token accounting.
 * @param usage - the last call's usage.
 * @returns a compact `↑in ↓out` summary.
 */
function formatUsage(usage: TokenUsage): string {
  return `↑${String(usage.inputTokens)} ↓${String(usage.outputTokens)}`
}

/**
 * The pinned footer under the composer: the workspace and Agent state against
 * the routed model, then the token accounting and context occupancy.
 */
export class StatusBar implements Component {
  private status: TuiStatus = {
    workspace: '',
    state: 'idle',
    model: '',
  }

  /**
   * @param theme - the surface theme.
   */
  constructor(private readonly theme: TuiTheme) {}

  /**
   * Replace the rendered status.
   * @param status - the current facts.
   */
  set(status: TuiStatus): void {
    this.status = status
  }

  /** Drop cached render state. */
  invalidate(): void {}

  /**
   * Render the footer.
   * @param width - the viewport width in columns.
   * @returns the footer lines, each within `width`.
   */
  render(width: number): string[] {
    return [
      this.pairLine(this.headText(), this.modelText(), width),
      truncateToWidth(this.statsLeft(), width),
    ]
  }

  /**
   * Place a right side against a left side at the footer's edges.
   *
   * The right side yields first — truncated, then dropped — so the identity and
   * state a user reads stay intact on a narrow terminal; only a left side wider
   * than the terminal is truncated itself.
   * @param left - the already styled left side.
   * @param right - the already styled right side.
   * @param width - the viewport width in columns.
   * @returns one line within `width`.
   */
  private pairLine(left: string, right: string, width: number): string {
    const leftWidth = visibleWidth(left)
    const available = width - leftWidth - STATUS_MIN_GAP
    const rightWidth = visibleWidth(right)
    if (rightWidth <= available) return left + ' '.repeat(width - leftWidth - rightWidth) + right
    if (available > 0) {
      const truncated = truncateToWidth(right, available, '')
      return left + ' '.repeat(width - leftWidth - visibleWidth(truncated)) + truncated
    }
    return truncateToWidth(left, width)
  }

  private headText(): string {
    const state = this.status.state === 'running' ? this.theme.accent('● running') : this.theme.dim('○ idle')
    const plan = this.status.plan === true ? `  ${this.theme.accent('plan')}` : ''
    return `${this.theme.dim(this.status.workspace)}  ${state}${plan}`
  }

  private modelText(): string {
    return this.theme.dim(this.status.effort === undefined
      ? this.status.model
      : `${this.status.model} • ${this.status.effort}`)
  }

  private statsLeft(): string {
    const parts: string[] = []
    if (this.status.usage !== undefined) parts.push(this.theme.dim(formatUsage(this.status.usage)))
    const context = this.contextPart()
    if (context !== '') parts.push(context)
    return parts.join(this.theme.dim('  '))
  }

  private contextPart(): string {
    const context = this.status.context
    if (context === undefined) return ''
    const share = context.tokens / context.window
    const text = `${(share * 100).toFixed(1)}%/${formatTokens(context.window)}${context.automatic ? ' (auto)' : ''}`
    if (share > STATUS_CONTEXT_ERROR) return this.theme.error(text)
    if (share > STATUS_CONTEXT_WARN) return this.theme.warning(text)
    return this.theme.dim(text)
  }
}

/**
 * The composer with a placeholder.
 *
 * While the composer is empty, its content row shows the key hints, so the
 * surface does not spend a footer line on keys the user already knows; the
 * first typed character replaces them.
 */
export class PlaceholderEditor implements Component, Focusable {
  private hint = ''

  /**
   * @param editor - the composer the user types into.
   * @param theme - the surface theme.
   */
  constructor(
    private readonly editor: Editor,
    private readonly theme: TuiTheme,
  ) {}

  /** Forward focus to the composer so it emits its cursor marker. */
  get focused(): boolean {
    return this.editor.focused
  }

  set focused(value: boolean) {
    this.editor.focused = value
  }

  /**
   * Replace the placeholder text.
   * @param hint - the key hints line.
   */
  setHint(hint: string): void {
    this.hint = hint
  }

  /** Forward input to the composer. */
  handleInput(data: string): void {
    this.editor.handleInput(data)
  }

  /** Drop the composer's cached render state. */
  invalidate(): void {
    this.editor.invalidate()
  }

  /**
   * Render the composer, showing the hints in place of an empty content line.
   * @param width - the viewport width in columns.
   * @returns the composer lines, each within `width`.
   */
  render(width: number): string[] {
    const lines = this.editor.render(width)
    if (this.hint === '' || this.editor.getText() !== '') return lines
    // An empty composer draws one content line between its two border lines.
    return lines.map((line, index) => (index === 1 ? this.placeholderLine(width) : line))
  }

  /**
   * The empty composer's content line: the hints with the cursor on their first
   * character, so an untouched composer still shows where typing lands. A focused
   * composer emits the hardware-cursor marker exactly as the editor does.
   * @param width - the viewport width in columns.
   * @returns the padded content line.
   */
  private placeholderLine(width: number): string {
    const available = Math.max(1, width - 2)
    const hint = truncateToWidth(this.hint, available, '')
    const cursor = `\x1b[7m${this.theme.dim(hint.slice(0, 1))}\x1b[27m`
    const content = `${this.focused ? CURSOR_MARKER : ''}${cursor}${this.theme.dim(hint.slice(1))}`
    return ` ${content}${' '.repeat(Math.max(0, available - visibleWidth(content)))} `
  }
}
