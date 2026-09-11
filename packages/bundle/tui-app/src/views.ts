/**
 * pi-tui components for the terminal surface: the transcript document, the
 * pinned status bar, and the formatting helpers they share. Every rendered line
 * is truncated to the viewport width because the renderer treats an over-wide
 * line as a component defect.
 * @module @deepseek-ai/dsh-tui-app/views
 */

import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type { Component, Focusable, MarkdownTheme } from '@earendil-works/pi-tui'
import { isFocusable } from '@earendil-works/pi-tui'
import { markdownTheme } from './ansi.ts'
import type { TuiTheme } from './ansi.ts'
import type { ToolEntry, TranscriptEntry } from './transcript.ts'
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
 * One-line account of a Tool call's arguments.
 * @param args - the raw arguments JSON string.
 * @returns a short, human-readable summary.
 */
export function summarizeToolArguments(args: string): string {
  const trimmed = args.trim()
  if (trimmed === '') return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as unknown
  } catch {
    // The model produced arguments the Tool will reject; show them verbatim.
    return trimmed
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return trimmed
  const record = parsed as Record<string, unknown>
  for (const key of TOOL_SUMMARY_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return `${key}=${value}`
  }
  const pairs = Object.entries(record).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
  return pairs.length === 0 ? '' : pairs.join(' ')
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
        return prefixBody(entry.text, width, this.theme.user('› '), '  ')
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
    const heading = `${style(marker)} ${this.theme.bold(entry.name)}${summary === '' ? '' : this.theme.dim(`(${summary})`)}`
    const lines = [truncateToWidth(heading, width)]
    if (entry.error !== undefined) lines.push(...prefixBody(entry.error, width, this.theme.error('  '), '  '))
    if (entry.result !== '') lines.push(...toolBody(entry.result, width))
    return lines
  }
}

/**
 * A modal panel: a titled frame that forwards keyboard input to the control it
 * wraps. The renderer focuses the component passed to `showOverlay`, and a bare
 * container does not forward keys, so the panel is the focused component.
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
   * Render the titled panel.
   * @param width - the viewport width in columns.
   * @returns the panel lines, each within `width`.
   */
  render(width: number): string[] {
    const lines = [truncateToWidth(this.theme.bold(this.title), width), '']
    for (const line of this.body.render(width)) {
      lines.push(visibleWidth(line) > width ? truncateToWidth(line, width) : line)
    }
    return lines
  }
}

/** One frame of the status bar. */
export interface TuiStatus {
  /** Session title or short id. */
  title: string
  /** Provider and model route. */
  route: string
  /** Workspace directory. */
  workspace: string
  /** Agent lifecycle state. */
  state: 'idle' | 'running'
  /** Token accounting for the last provider call, already formatted. */
  usage?: string
}

/** The pinned two-line footer: identity and state, then the key hints. */
export class StatusBar implements Component {
  private status: TuiStatus = {
    title: '',
    route: '',
    workspace: '',
    state: 'idle',
  }
  private hints = ''

  /**
   * @param theme - the surface theme.
   */
  constructor(private readonly theme: TuiTheme) {}

  /**
   * Replace the rendered status.
   * @param status - the current facts.
   * @param hints - the key hints line.
   */
  set(status: TuiStatus, hints: string): void {
    this.status = status
    this.hints = hints
  }

  /** Drop cached render state. */
  invalidate(): void {}

  /**
   * Render the footer.
   * @param width - the viewport width in columns.
   * @returns the footer lines, each within `width`.
   */
  render(width: number): string[] {
    const status = this.status
    const state = status.state === 'running' ? this.theme.accent('● running') : this.theme.dim('○ idle')
    const usage = status.usage === undefined ? '' : `  ${this.theme.dim(status.usage)}`
    const head = `${this.theme.bold(status.title)}  ${state}${usage}`
    const detail = this.theme.dim(`${status.route}  ${status.workspace}`)
    return [
      truncateToWidth(head, width),
      truncateToWidth(detail, width),
      truncateToWidth(this.theme.dim(this.hints), width),
    ]
  }
}
