/**
 * pi-tui components for the terminal surface: the transcript document, the
 * pinned status bar, and the formatting helpers they share. Every rendered line
 * is truncated to the viewport width because the renderer treats an over-wide
 * line as a component defect.
 * @module @deepseek-ai/dsh-tui-app/views
 */

import { CURSOR_MARKER, Key, Markdown, SelectList, getKeybindings, isFocusable, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type { Component, Editor, Focusable, MarkdownTheme, SelectItem, SelectListLayoutOptions, SelectListTheme, TuiMouseEvent, TuiMouseEventResult } from '@earendil-works/pi-tui'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { FileDiff, ReadFileLine, SearchResultView, WebResultView } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { markdownTheme } from './ansi.ts'
import type { Styler, TuiTheme } from './ansi.ts'
import { buildDiffCard } from './diff.ts'
import type { DiffCard, DiffRow } from './diff.ts'
import type { ToolEntry, TranscriptEntry, UserEntry } from './transcript.ts'
import { TerminalTranscript, textOfBlocks } from './transcript.ts'

/** Indent applied to a Tool row's result body. */
const TOOL_BODY_INDENT = '    '
/** Result lines shown before the row is folded. */
const TOOL_RESULT_MAX_LINES = 12
/** Diff body rows shown before the row is folded. */
const DIFF_MAX_LINES = 24
/** Longest Tool argument summary kept on the heading line. */
const TOOL_SUMMARY_MAX_CHARS = 96
/** Argument keys worth showing alone, in preference order. */
const TOOL_SUMMARY_KEYS = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'prompt', 'description', 'name']

/**
 * The presentation one Tool row draws, after the call and result views are
 * reconciled. It mirrors the Host vocabulary but merges a result card with the
 * call card it completes, so a terminal result keeps the command heading and
 * working directory its call declared. Fields the terminal cannot draw — a
 * generic card's `kind` and a read card's `lang` — are not carried.
 */
type RowCard =
  | { card: 'generic'; title?: string | undefined; rawInput?: unknown; content?: readonly ContentBlock[] | undefined }
  | { card: 'terminal'; title?: string | undefined; description?: string | undefined; cwd?: string | undefined; output?: string | undefined; exitCode?: number | undefined; signal?: string | undefined }
  | { card: 'diff'; title?: string | undefined; diffs: readonly FileDiff[] }
  | { card: 'read'; title?: string | undefined; path: string; offset: number; lines: readonly ReadFileLine[]; totalLines: number }
  | { card: 'search'; title?: string | undefined; view: SearchResultView }
  | { card: 'web'; title?: string | undefined; view: WebResultView }

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
    parsed = JSON.parse(trimmed)
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
 * Unwrap the single fenced code block a generic result view uses as its
 * UI-facing form. The terminal draws plain text, so the block's text is the
 * body and the markdown fence around it would print literally. Any other text,
 * including a fence without a trailing block, is returned unchanged.
 * @param text - the generic card's text content.
 * @returns the block's body, or the original text.
 */
function unfence(text: string): string {
  const match = /^```[^\n]*\n([\s\S]*)\n```$/u.exec(text)
  return match?.[1] ?? text
}

/**
 * Resolve the card one Tool row draws from the views its call and result
 * declared.
 *
 * A settled result view wins over the call view; a result that omits a title
 * or the call-only terminal fields keeps the call values they replace, and a
 * result the Tool did not declare leaves the call view in place. An error, a
 * missing resolver, or an empty diff hunk list falls back to the raw row.
 * @param entry - the folded Tool row.
 * @returns the card to draw, or undefined for the raw name-and-result row.
 */
function resolveRowCard(entry: ToolEntry): RowCard | undefined {
  if (entry.status === 'error') return undefined
  const call = entry.callView
  const result = entry.resultView
  const callTitle = call === undefined ? undefined : call.title
  if (result !== undefined) {
    if (result.card === 'diff') return { card: 'diff', title: result.title ?? callTitle, diffs: result.diffs }
    if (result.card === 'terminal') {
      const base = call?.card === 'terminal' ? call : undefined
      return {
        card: 'terminal',
        title: result.title ?? base?.title,
        description: base?.description,
        cwd: base?.cwd,
        output: result.output,
        exitCode: result.exitCode,
        signal: result.signal,
      }
    }
    if (result.card === 'read') {
      return {
        card: 'read',
        title: result.title ?? callTitle,
        path: result.path,
        offset: result.offset,
        lines: result.lines,
        totalLines: result.totalLines,
      }
    }
    if (result.card === 'search') return { card: 'search', title: result.title ?? callTitle, view: result }
    if (result.card === 'web') return { card: 'web', title: result.title ?? callTitle, view: result }
    return {
      card: 'generic',
      title: result.title ?? callTitle,
      rawInput: call?.card === 'generic' ? call.rawInput : undefined,
      content: result.content ?? (call?.card === 'generic' ? call.content : undefined),
    }
  }
  if (call === undefined) return undefined
  switch (call.card) {
    case 'generic':
      return { card: 'generic', title: call.title, rawInput: call.rawInput, content: call.content }
    case 'terminal':
      return { card: 'terminal', title: call.title, description: call.description, cwd: call.cwd }
    case 'diff':
      return call.diffs.length === 0 ? undefined : { card: 'diff', title: call.title, diffs: call.diffs }
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default:
      return assertNever(call, 'tool call view card')
  }
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
 * @param style - the Tool-result body style.
 * @returns the indented body lines.
 */
function toolBody(text: string, width: number, style: Styler): string[] {
  const bodyWidth = Math.max(1, width - TOOL_BODY_INDENT.length)
  const lines = wrap(text, bodyWidth)
  if (lines.length <= TOOL_RESULT_MAX_LINES) return lines.map(line => TOOL_BODY_INDENT + style(line))
  const shown = lines.slice(0, TOOL_RESULT_MAX_LINES).map(line => TOOL_BODY_INDENT + style(line))
  shown.push(TOOL_BODY_INDENT + style(`… ${String(lines.length - TOOL_RESULT_MAX_LINES)} more lines`))
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
    private readonly transcript: TerminalTranscript,
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
    const marker = entry.status === 'running' ? '⏺' : entry.status === 'ok' ? '✔' : '✘'
    const style = entry.status === 'running'
      ? this.theme.tool
      : entry.status === 'ok' ? this.theme.toolOk : this.theme.toolError
    const card = resolveRowCard(entry)
    // An error clears every view in the fold, so a card and an error never
    // coexist; the raw branch below is the only one that draws one.
    const lines = card === undefined
      ? [truncateToWidth(this.nameHeading(entry, marker, style), width)]
      : this.cardLines(entry, card, marker, style, width)
    if (entry.error !== undefined) lines.push(...prefixBody(entry.error, width, this.theme.error('  '), '  '))
    if (card === undefined && entry.result !== '') lines.push(...toolBody(entry.result, width, this.theme.toolResult))
    return lines
  }

  /** One Tool row's heading and body for the card its views resolved to. */
  private cardLines(entry: ToolEntry, card: RowCard, marker: string, style: Styler, width: number): string[] {
    switch (card.card) {
      case 'generic':
        return this.genericLines(entry, card, marker, style, width)
      case 'terminal':
        return this.terminalLines(entry, card, marker, style, width)
      case 'diff':
        return this.diffLines(entry, card, marker, style, width)
      case 'read':
        return this.readLines(card, marker, style, width)
      case 'search':
        return this.searchLines(entry, card, marker, style, width)
      case 'web':
        return this.webLines(entry, card, marker, style, width)
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(card, 'tool row card')
    }
  }

  /** The ordinary heading: the Tool name and a one-line argument summary. */
  private nameHeading(entry: ToolEntry, marker: string, style: Styler): string {
    const summary = truncateToWidth(summarizeToolArguments(entry.args), TOOL_SUMMARY_MAX_CHARS, '…')
    return `${style(marker)} ${this.theme.bold(singleLine(entry.name))}${summary === '' ? '' : this.theme.dim(`(${summary})`)}`
  }

  /**
   * A generic card's rows: the Tool's declared title (falling back to the
   * ordinary name heading) and raw-input summary, then its UI-facing content or
   * the raw result text.
   */
  private genericLines(entry: ToolEntry, card: Extract<RowCard, { card: 'generic' }>, marker: string, style: Styler, width: number): string[] {
    const heading = card.title === undefined
      ? this.nameHeading(entry, marker, style)
      : `${style(marker)} ${this.theme.bold(singleLine(card.title))}${this.rawInputSuffix(card.title, card.rawInput)}`
    const lines = [truncateToWidth(heading, width)]
    const content = card.content === undefined ? '' : unfence(textOfBlocks(card.content))
    const body = content !== '' ? content : entry.result
    if (body !== '') lines.push(...toolBody(body, width, this.theme.toolResult))
    return lines
  }

  /**
   * The parenthesized suffix a generic card shows for its salient raw input.
   * A title that already spells the input out suppresses the repetition.
   * @param title - the card's declared title.
   * @param rawInput - the presenter's salient input.
   * @returns the suffix, or an empty string when it adds nothing.
   */
  private rawInputSuffix(title: string, rawInput: unknown): string {
    if (rawInput === undefined) return ''
    // Presenter raw input is JSON-safe by contract, so stringify always yields text.
    const text = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput)
    if (text === '' || title.includes(text)) return ''
    return ` ${this.theme.dim(`(${truncateToWidth(singleLine(text), TOOL_SUMMARY_MAX_CHARS, '…')})`)}`
  }

  /** A terminal card's rows: description, command heading with cwd and exit state, then output. */
  private terminalLines(entry: ToolEntry, card: Extract<RowCard, { card: 'terminal' }>, marker: string, style: Styler, width: number): string[] {
    const lines: string[] = []
    if (card.description !== undefined && card.description !== '') {
      lines.push(truncateToWidth(this.theme.dim(singleLine(card.description)), width))
    }
    const title = card.title ?? entry.name
    const cwd = card.cwd === undefined || card.cwd === '' ? '' : this.theme.dim(`${singleLine(card.cwd)} `)
    lines.push(truncateToWidth(`${style(marker)} ${cwd}${this.theme.bold(singleLine(title))}${this.exitPill(card)}`, width))
    const output = card.output ?? entry.result
    if (output !== '') lines.push(...toolBody(output, width, this.theme.toolResult))
    return lines
  }

  /** The exit-status pill a settled terminal card declares, when it declares one. */
  private exitPill(card: Extract<RowCard, { card: 'terminal' }>): string {
    if (card.exitCode !== undefined) {
      return card.exitCode === 0
        ? `  ${this.theme.dim('exit 0')}`
        : `  ${this.theme.error(`exit ${String(card.exitCode)}`)}`
    }
    if (card.signal !== undefined) return `  ${this.theme.error(singleLine(card.signal))}`
    return ''
  }

  /** A mutation's rows: the declared title with +/- totals, then the unified diff. */
  private diffLines(entry: ToolEntry, card: Extract<RowCard, { card: 'diff' }>, marker: string, style: Styler, width: number): string[] {
    const built = buildDiffCard(card.diffs)
    const lines = [truncateToWidth(this.diffHeading(entry, card.title, built, marker, style), width)]
    lines.push(...this.diffBody(built, width))
    return lines
  }

  /** A read card's rows: the title and window extent, then numbered file lines. */
  private readLines(card: Extract<RowCard, { card: 'read' }>, marker: string, style: Styler, width: number): string[] {
    const label = card.title ?? `Read ${card.path}`
    const first = card.lines.at(0)
    const last = card.lines.at(-1)
    const extent = first === undefined || last === undefined
      ? `line ${String(card.offset)}`
      : first.number === last.number ? `line ${String(first.number)}` : `lines ${String(first.number)}-${String(last.number)}`
    const stat = this.theme.dim(`  ${extent} of ${String(card.totalLines)}`)
    const lines = [truncateToWidth(`${style(marker)} ${this.theme.bold(singleLine(label))}${stat}`, width)]
    lines.push(...this.boundedRows(card.lines.map(line => `${this.theme.dim(String(line.number).padStart(4))} ${this.theme.toolResult(line.text)}`), width))
    return lines
  }

  /** A search card's rows: grouped matched lines or a path list, with the cap signal. */
  private searchLines(entry: ToolEntry, card: Extract<RowCard, { card: 'search' }>, marker: string, style: Styler, width: number): string[] {
    const label = card.title ?? entry.name
    const lines = [truncateToWidth(`${style(marker)} ${this.theme.bold(singleLine(label))}${this.searchCap(card.view)}`, width)]
    const rows: string[] = []
    if (card.view.shape === 'matches') {
      for (const file of card.view.files) {
        rows.push(this.theme.bold(singleLine(file.path)))
        for (const match of file.matches) rows.push(`  ${this.theme.dim(`${String(match.lineNumber)}:`)} ${this.theme.toolResult(match.line)}`)
      }
    } else {
      for (const path of card.view.paths) rows.push(this.theme.toolResult(singleLine(path)))
    }
    lines.push(...this.boundedRows(rows, width))
    return lines
  }

  /** The cap signal a truncated search card declares. */
  private searchCap(view: SearchResultView): string {
    if (!view.truncated) return ''
    const retained = view.shape === 'matches'
      ? view.files.reduce((sum, file) => sum + file.matches.length, 0)
      : view.paths.length
    return `  ${this.theme.dim(`showing ${String(retained)} of ${String(view.total)}`)}`
  }

  /** A web card's rows: the cited sources with the provider answer, or the fetch summary. */
  private webLines(entry: ToolEntry, card: Extract<RowCard, { card: 'web' }>, marker: string, style: Styler, width: number): string[] {
    const view = card.view
    const label = card.title ?? entry.name
    const lines = [truncateToWidth(`${style(marker)} ${this.theme.bold(singleLine(label))}`, width)]
    const rows: string[] = []
    if (view.kind === 'search') {
      for (const source of view.sources) {
        const sourceLabel = source.title === undefined || source.title === '' ? source.url : `${source.title} — ${source.url}`
        rows.push(this.theme.toolResult(singleLine(sourceLabel)))
      }
      if (view.answer !== undefined && view.answer !== '') rows.push(this.theme.dim(singleLine(view.answer)))
      if (view.truncated) rows.push(this.theme.dim('… more sources'))
    } else {
      rows.push(this.theme.toolResult(`${singleLine(view.url)} · HTTP ${String(view.statusCode)}`))
      if (view.truncated) rows.push(this.theme.dim('… body truncated'))
    }
    lines.push(...this.boundedRows(rows, width))
    return lines
  }

  /**
   * Indent and bound pre-styled body rows to the viewport width.
   * @param rows - the already-styled rows.
   * @param width - the viewport width.
   * @returns the indented rows, folded when they exceed the body budget.
   */
  private boundedRows(rows: readonly string[], width: number): string[] {
    const bodyWidth = Math.max(1, width - TOOL_BODY_INDENT.length)
    const shown = rows.slice(0, TOOL_RESULT_MAX_LINES).map(row => TOOL_BODY_INDENT + truncateToWidth(row, bodyWidth))
    if (rows.length > TOOL_RESULT_MAX_LINES) {
      shown.push(TOOL_BODY_INDENT + this.theme.dim(`… ${String(rows.length - TOOL_RESULT_MAX_LINES)} more lines`))
    }
    return shown
  }

  /** A mutation's heading: the Tool's own card title and the change's +/- totals. */
  private diffHeading(entry: ToolEntry, title: string | undefined, card: DiffCard, marker: string, style: Styler): string {
    const label = title ?? singleLine(entry.name)
    const stat = card.added === 0 && card.removed === 0
      ? ''
      : `${this.theme.dim('  ')}${this.theme.diffAdd(`+${String(card.added)}`)}${this.theme.dim(' ')}${this.theme.diffDel(`-${String(card.removed)}`)}`
    return `${style(marker)} ${this.theme.bold(label)}${stat}`
  }

  /**
   * A diff card's indented body, folded to a bounded number of rows.
   * @param card - the built diff card.
   * @param width - the viewport width.
   * @returns the indented body lines.
   */
  private diffBody(card: DiffCard, width: number): string[] {
    const bodyWidth = Math.max(1, width - TOOL_BODY_INDENT.length)
    const lines = card.rows.slice(0, DIFF_MAX_LINES).map(row => TOOL_BODY_INDENT + this.diffRow(row, bodyWidth))
    if (card.rows.length > DIFF_MAX_LINES) {
      lines.push(TOOL_BODY_INDENT + this.theme.dim(`… ${String(card.rows.length - DIFF_MAX_LINES)} more lines`))
    }
    return lines
  }

  /** One diff row with its role's prefix and style, truncated to the body width. */
  private diffRow(row: DiffRow, width: number): string {
    switch (row.kind) {
      case 'path':
        return truncateToWidth(this.theme.diffMeta(row.text), width)
      case 'gap':
        return this.theme.dim(row.text)
      case 'context':
        return truncateToWidth(this.theme.diffContext(`  ${row.text}`), width)
      case 'added':
        return truncateToWidth(this.theme.diffAdd(`+ ${row.text}`), width)
      case 'removed':
        return truncateToWidth(this.theme.diffDel(`- ${row.text}`), width)
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(row.kind, 'diff row kind')
    }
  }
}

/** Tallest detail-less prompt panel, so a long picker does not fill a tall terminal. */
const PICKER_PANEL_MAX_ROWS = 18
/** Most rows a prompt heading occupies; a longer question keeps its first rows and ends with an ellipsis. */
export const PROMPT_TITLE_MAX_ROWS = 3
/** Rows a prompt spends outside its body at most: the wrapped heading and the blank row under it. */
export const PROMPT_PANEL_CHROME_ROWS = PROMPT_TITLE_MAX_ROWS + 1
/** Rows a multi-select picker spends on its key hint below the list. */
export const MULTI_SELECT_HINT_ROWS = 1

/**
 * Row budget for one prompt panel on a terminal with `rows` rows left to it.
 * @param rows - rows available to the panel, excluding any pinned footer.
 * @param detailed - whether the body carries scrollable detail under a control.
 * Such a panel may take every available row, because the detail is what the user
 * must read; a detail-less picker stays capped so a long list does not fill a
 * tall terminal.
 * @returns the largest panel height, keeping at least one body row.
 */
export function promptPanelRows(rows: number, detailed = false): number {
  const available = Math.max(1, rows - 2)
  const cap = detailed ? available : Math.min(PICKER_PANEL_MAX_ROWS, available)
  return Math.max(PROMPT_PANEL_CHROME_ROWS + 1, cap)
}

/** Rows the scroll position line under a detailed prompt spends once its detail overflows. */
const DETAIL_SCROLL_HINT_ROWS = 1

/**
 * A modal body that shows a prompt's supporting detail above its control.
 *
 * `detail` is markdown the caller supplied — a plan under review, or facts a
 * question rests on — and can be taller than the panel. The detail renders in a
 * viewport that yields every row its control does not use; the control's
 * rendered height, not a fixed split, sizes the viewport, so a two-option
 * review gives the plan nearly the whole panel and a long picker leaves the
 * plan less.
 *
 * Scrolling keys depend on whether the detail overflows. While it does, Up and
 * Down scroll it by one row, PageUp and PageDown by one viewport, and the wheel
 * by its reported lines; a control that supplies `step` is then moved with Left
 * and Right (or Tab and Shift+Tab), which keeps those keys off the scroller.
 * While the detail fits, every key reaches the control unchanged, so a plain
 * picker keeps its own Up, Down, Enter, and Escape bindings.
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
   * @param step - moves the control's selection by one item while the detail
   * overflows; absent when the control has no selection to move.
   */
  constructor(
    detail: string,
    private readonly control: Component,
    private readonly theme: TuiTheme,
    private readonly rows: number,
    private readonly step?: (delta: -1 | 1) => void,
  ) {
    this.markdown = new Markdown(detail, 0, 0, markdownTheme(theme))
  }

  /**
   * Scroll the overflowing detail, move the control's selection, or hand the
   * key to the control.
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
    if (this.viewport > 0 && this.content > this.viewport) {
      if (matchesKey(data, Key.up)) {
        this.scrollTo(this.scrollTop - 1)
        return
      }
      if (matchesKey(data, Key.down)) {
        this.scrollTo(this.scrollTop + 1)
        return
      }
      if (this.step !== undefined) {
        if (matchesKey(data, Key.left) || matchesKey(data, Key.shift('tab'))) {
          this.step(-1)
          return
        }
        if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
          this.step(1)
          return
        }
      }
    }
    if (isFocusable(this.control)) this.control.focused = true
    this.control.handleInput?.(data)
  }

  /**
   * Scroll the detail with the wheel, or hand the mouse event to the control.
   * @param event - the normalized mouse event.
   * @returns the control's result, or `handled` for a consumed wheel event.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === 'wheel' && event.wheelDelta !== undefined) {
      this.scrollTo(this.scrollTop + event.wheelDelta)
      return { handled: true }
    }
    return this.control.handleMouse?.(event)
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
      const keys = this.step === undefined ? '↑↓/PgUp/PgDn scroll' : '↑↓/PgUp/PgDn scroll · ←→ choose'
      lines.push(this.theme.dim(`  ${String(this.scrollTop + 1)}–${String(end)}/${String(detail.length)} · ${keys}`))
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
 * A prompt heading. Its header and trailing text stay on the first row — a
 * header labeling the question, a trailing countdown at the right edge — while
 * the question itself wraps across the heading rows.
 */
export interface PromptHeading {
  /** Dim label above the question, such as the question's header or its batch position. */
  readonly header?: string | undefined
  /** The question presented to the user, wrapped across the heading rows. */
  readonly question: string
  /** Text pinned to the right of the first heading row, such as a timed window's countdown. */
  readonly trailing?: string | undefined
}

/** A prompt heading: a plain line, a structured heading, or a provider of either re-evaluated each repaint. */
export type PromptTitle = string | PromptHeading | (() => string | PromptHeading)

/**
 * Wrap a heading into its rows.
 *
 * The header keeps its own row and the question takes the rest, ending in an
 * ellipsis once it exceeds them.
 * @param value - the heading to wrap.
 * @param width - the available columns.
 * @returns the header row, when the heading carries one, and the question's rows.
 */
function wrapHeading(value: string | PromptHeading, width: number): { readonly header?: string; readonly question: readonly string[] } {
  const header = typeof value === 'string' ? undefined : value.header
  const question = typeof value === 'string' ? value : value.question
  const budget = Math.max(1, PROMPT_TITLE_MAX_ROWS - (header === undefined ? 0 : 1))
  const wrapped = wrapTextWithAnsi(singleLine(question), width)
  const kept = wrapped.length <= budget
    ? wrapped
    : [...wrapped.slice(0, budget - 1), `${truncateToWidth(wrapped[budget - 1] as string, width - 1, '')}…`]
  return {
    ...header === undefined ? {} : { header: singleLine(header) },
    question: kept,
  }
}

/**
 * Rows a prompt heading occupies at one width.
 *
 * A prompt reserves its body budget from this before the first paint, so the
 * body never overflows the rows the heading's wrapping left it.
 * @param value - the headed value to measure.
 * @param width - the available columns.
 * @returns the number of rows the panel draws for the heading.
 */
export function promptHeadingRows(value: string | PromptHeading, width: number): number {
  const wrapped = wrapHeading(value, width)
  return (wrapped.header === undefined ? 0 : 1) + wrapped.question.length
}

/**
 * A modal panel: a heading, a blank row, and the control that handles keys. The
 * renderer focuses the component passed to `showOverlay`, and a bare container
 * does not forward keys, so the panel is the focused component.
 *
 * Escape is intercepted here instead of by the control: the control binds it
 * together with Ctrl+C to one cancel action, so a prompt that offers a skip
 * could not otherwise tell the two apart. Ctrl+C keeps its own meaning and
 * reaches the control's cancel binding.
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
  /** Called when the user presses Escape to move past the prompt without answering. */
  onSkip?: () => void

  /** Heading rows the last render drew, so a mouse event keeps the control's own coordinates. */
  private headingRows = 1

  /**
   * @param title - the heading, or a provider evaluated on every render for a
   * heading that changes while the panel is open, such as a countdown.
   * @param theme - the surface theme.
   * @param body - the control that handles keys.
   */
  constructor(
    private readonly title: PromptTitle,
    private readonly theme: TuiTheme,
    private readonly body: Component,
  ) {}

  /**
   * Answer Escape as a skip and hand every other key to the wrapped control.
   * @param data - raw key bytes.
   */
  handleInput(data: string): void {
    if (isFocusable(this.body)) this.body.focused = true
    if (this.onSkip !== undefined && matchesKey(data, Key.escape)) {
      this.onSkip()
      return
    }
    this.body.handleInput?.(data)
  }

  /**
   * Forward a mouse event past the panel's chrome to the wrapped control, so a
   * scrolling body reaches its own viewport at the rows it rendered. Events on
   * the heading or blank row belong to no control.
   * @param event - the normalized mouse event, in panel coordinates.
   * @returns the body's result, when it handled the event.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const chrome = this.headingRows + 1
    if (event.y < chrome) return undefined
    return this.body.handleMouse?.({
      ...event,
      y: event.y - chrome,
      height: Math.max(0, event.height - chrome),
    })
  }

  /** Drop the wrapped control's cached render state. */
  invalidate(): void {
    this.body.invalidate()
  }

  /**
   * Render the heading and body, filling every row the overlay covers.
   * @param width - the viewport width in columns.
   * @returns the panel lines, each exactly `width` columns wide.
   */
  render(width: number): string[] {
    const available = Math.max(1, width)
    const heading = this.heading(available)
    this.headingRows = heading.length
    const lines = [...heading, '', ...this.body.render(available)]
    return lines.map(line => this.row(line, available))
  }

  /**
   * Wrap the heading into at most {@link PROMPT_TITLE_MAX_ROWS} rows.
   * @param width - the available columns.
   * @returns the styled heading rows.
   */
  private heading(width: number): string[] {
    const value = typeof this.title === 'function' ? this.title() : this.title
    const wrapped = wrapHeading(value, width)
    const rows: string[] = []
    if (wrapped.header !== undefined) rows.push(this.theme.dim(truncateToWidth(wrapped.header, width, '…')))
    for (const line of wrapped.question) rows.push(this.theme.bold(line))
    const trailing = typeof value === 'string' ? undefined : value.trailing
    if (trailing !== undefined) rows[0] = this.withTrailing(rows[0] as string, singleLine(trailing), width)
    return rows
  }

  /**
   * Pin one line of text to the right of a heading row.
   * @param line - the heading row.
   * @param trailing - the text to pin.
   * @param width - the available columns.
   * @returns the row with the trailing text at its right edge.
   */
  private withTrailing(line: string, trailing: string, width: number): string {
    const suffix = `  ${trailing}`
    const suffixWidth = visibleWidth(suffix)
    if (suffixWidth >= width) return truncateToWidth(suffix, width, '…')
    return truncateToWidth(line, width - suffixWidth, '…') + suffix
  }

  private row(text: string, available: number): string {
    const clipped = visibleWidth(text) > available ? truncateToWidth(text, available, '…') : text
    return clipped + ' '.repeat(Math.max(0, available - visibleWidth(clipped)))
  }
}

/**
 * A single-select picker that answers only keyboard input.
 *
 * `SelectList` confirms a left click on a row and moves the highlight on the
 * wheel; a stray click in the terminal would settle a prompt the user only meant
 * to focus. This wrapper exposes no mouse handler, so the arrow keys move the
 * highlight and Enter or Escape are the only ways to settle the list. It
 * forwards the wrapped picker's own key handling, selection callbacks, and
 * render state.
 */
export class KeyboardSelectList implements Component {
  /** Called with the highlighted option when the user confirms. */
  onSelect?: (item: SelectItem) => void
  /** Called when the user cancels. */
  onCancel?: () => void
  /** Called whenever the highlighted option changes. */
  onSelectionChange?: (item: SelectItem) => void

  private readonly list: SelectList

  /**
   * @param items - the options to show.
   * @param maxVisible - most rows the picker shows before scrolling.
   * @param theme - the picker theme.
   * @param layout - the picker's column layout.
   */
  constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme, layout?: SelectListLayoutOptions) {
    this.list = new SelectList(items, maxVisible, theme, layout)
    this.list.onSelect = (item) => { this.onSelect?.(item) }
    this.list.onCancel = () => { this.onCancel?.() }
    this.list.onSelectionChange = (item) => { this.onSelectionChange?.(item) }
  }

  /**
   * Forward keyboard input to the wrapped picker.
   * @param data - raw key bytes.
   */
  handleInput(data: string): void {
    this.list.handleInput(data)
  }

  /**
   * Move the highlight onto one option.
   * @param index - the option index; clamped to the list.
   */
  setSelectedIndex(index: number): void {
    this.list.setSelectedIndex(index)
  }

  /**
   * The highlighted option.
   * @returns the highlighted option, or null when the list shows none.
   */
  getSelectedItem(): SelectItem | null {
    return this.list.getSelectedItem()
  }

  /** Drop the wrapped picker's cached render state. */
  invalidate(): void {
    this.list.invalidate()
  }

  /**
   * Render the wrapped picker's options.
   * @param width - the viewport width in columns.
   * @returns the picker lines.
   */
  render(width: number): string[] {
    return this.list.render(width)
  }
}

/** Marker a checked multi-select row draws before its label. */
const MULTI_SELECT_CHECKED = '[x] '
/** Marker an unchecked multi-select row draws before its label. */
const MULTI_SELECT_UNCHECKED = '[ ] '
/** Columns both markers occupy, so a toggle swaps one for the other in place. */
const MULTI_SELECT_MARKER_WIDTH = 4

/**
 * A modal picker whose options are checked with Space and submitted with Enter.
 *
 * The single-select picker confirms on the same key that moves, so a checkable
 * list cannot reuse it unchanged: this owns the check state and wraps the picker
 * for navigation, scrolling, and rendering. Every option it passes down is its
 * own copy whose label carries the marker, so a toggle rewrites that label in
 * place — the picker renders the objects it was given, so the marker follows the
 * check state without a second rendering path. Enter submits the checked options
 * in list order and is ignored while none is checked, so a stray confirm cannot
 * answer with an empty selection; Escape still cancels.
 */
export class MultiSelectList implements Component {
  /** Called with the checked options in list order when the user confirms. */
  onConfirm?: (items: SelectItem[]) => void
  /** Called when the user cancels the picker. */
  onCancel?: () => void
  /** Called whenever the highlighted option changes. */
  onSelectionChange?: (item: SelectItem) => void

  private readonly list: KeyboardSelectList
  private readonly items: SelectItem[]
  private readonly theme: SelectListTheme

  /**
   * @param items - the options to check.
   * @param maxVisible - most rows the picker shows before scrolling.
   * @param theme - the picker theme shared with the single-select list.
   * @param layout - the picker's column layout.
   */
  constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme, layout?: SelectListLayoutOptions) {
    this.theme = theme
    this.items = items.map(item => ({ ...item, label: MULTI_SELECT_UNCHECKED + item.label }))
    this.list = new KeyboardSelectList(this.items, maxVisible, theme, layout)
    this.list.onCancel = () => { this.onCancel?.() }
    this.list.onSelectionChange = (item) => { this.onSelectionChange?.(item) }
  }

  /**
   * Toggle the highlighted option on Space, confirm the checked ones on Enter,
   * and hand every other key to the wrapped picker.
   * @param data - raw key bytes.
   */
  handleInput(data: string): void {
    if (matchesKey(data, Key.space)) {
      const item = this.list.getSelectedItem()
      if (item !== null) this.toggle(item)
      return
    }
    if (getKeybindings().matches(data, 'tui.select.confirm')) {
      const checked = this.selectedItems()
      if (checked.length > 0) this.onConfirm?.(checked)
      return
    }
    this.list.handleInput(data)
  }

  /**
   * Move the highlight onto one option.
   * @param index - the option index; clamped to the list.
   */
  setSelectedIndex(index: number): void {
    this.list.setSelectedIndex(index)
  }

  /** Drop the wrapped picker's cached render state. */
  invalidate(): void {
    this.list.invalidate()
  }

  /**
   * Render the options with their check markers and the key hint.
   * @param width - the viewport width in columns.
   * @returns the picker lines, the hint last.
   */
  render(width: number): string[] {
    return [
      ...this.list.render(width),
      this.theme.description('  Space toggle · Enter confirm'),
    ]
  }

  /**
   * The checked options.
   * @returns the checked options in list order.
   */
  selectedItems(): SelectItem[] {
    return this.items.filter(item => item.label.startsWith(MULTI_SELECT_CHECKED))
  }

  private toggle(item: SelectItem): void {
    const checked = item.label.startsWith(MULTI_SELECT_CHECKED)
    item.label = (checked ? MULTI_SELECT_UNCHECKED : MULTI_SELECT_CHECKED) + item.label.slice(MULTI_SELECT_MARKER_WIDTH)
    this.list.invalidate()
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

/** Whole-log token figures the footer's bottom-right group reports. */
export interface TuiSessionStats {
  /** Decode throughput averaged over decode-timed steps; absent until one is timed. */
  tokensPerSecond?: number | undefined
  /** Billed prompt tokens over the whole log: uncached input plus cache reads and writes. */
  promptTokens: number
  /** Provider-reported output tokens over the whole log. */
  outputTokens: number
  /** Prompt tokens the provider served from cache. */
  cacheReadTokens: number
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
  /** Whether a clipboard image read is in flight; the identity line reports the wait. */
  pasting?: boolean | undefined
  /** Context occupancy, absent until the meter reports both a pressure and a capacity. */
  context?: TuiContextStatus | undefined
  /** Whole-log throughput and token totals; absent when the frame carries no measurement. */
  stats?: TuiSessionStats | undefined
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
 * Compact whole-token throughput, at the Web stats strip's precision.
 * @param value - decode tokens per second.
 * @returns whole tokens from ten per second, one decimal below.
 */
function formatTokensPerSecond(value: number): string {
  const clamped = Math.max(0, value)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

/**
 * Cache-read share of the billed prompt, without rounding a partial hit to 100%.
 * @param cacheReadTokens - prompt tokens served from cache.
 * @param promptTokens - billed prompt tokens.
 * @returns percentage text, or empty string when no prompt tokens were billed.
 */
function cacheHitText(cacheReadTokens: number, promptTokens: number): string {
  if (promptTokens <= 0) return ''
  if (cacheReadTokens >= promptTokens) return '100'
  const tenths = Math.min(999, Math.round((cacheReadTokens / promptTokens) * 1_000))
  return tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1)
}

/**
 * Display parts of the footer's bottom-right group, in display order: whole-log
 * decode throughput, the billed token total, and the cache-hit share. A figure
 * whose input has no data is omitted rather than shown as zero.
 * @param stats - the whole-log token figures for one frame.
 * @returns one text per available figure.
 */
export function sessionStatsParts(stats: TuiSessionStats): string[] {
  const parts: string[] = []
  if (stats.tokensPerSecond !== undefined) {
    parts.push(`${formatTokensPerSecond(stats.tokensPerSecond)} tok/s`)
  }
  const total = stats.promptTokens + stats.outputTokens
  if (total > 0) parts.push(`${formatTokens(total)} tok`)
  const cache = cacheHitText(stats.cacheReadTokens, stats.promptTokens)
  if (cache !== '') parts.push(`${cache}% cache`)
  return parts
}

/**
 * The pinned footer under the composer: the workspace and Agent state against
 * the routed model, then the context occupancy with the whole-log token figures
 * at the bottom-right edge.
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
    const right = this.statsRight()
    const left = this.contextPart()
    return [
      this.pairLine(this.headText(), this.modelText(), width),
      right === '' ? truncateToWidth(left, width) : this.pairLine(left, right, width),
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
    const pasting = this.status.pasting === true ? `  ${this.theme.dim('pasting image…')}` : ''
    return `${this.theme.dim(this.status.workspace)}  ${state}${plan}${pasting}`
  }

  private modelText(): string {
    return this.theme.dim(this.status.effort === undefined
      ? this.status.model
      : `${this.status.model} • ${this.status.effort}`)
  }

  /** The bottom-right group: whole-log throughput, token total, and cache-hit share. */
  private statsRight(): string {
    const stats = this.status.stats
    if (stats === undefined) return ''
    return sessionStatsParts(stats)
      .map(part => this.theme.dim(part))
      .join(this.theme.dim('  '))
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
    // The cursor character stays unstyled: every styler ends with an SGR reset,
    // which would cancel the reverse video that draws the block.
    const cursor = `\x1b[7m${hint.slice(0, 1)}\x1b[27m`
    const content = `${this.focused ? CURSOR_MARKER : ''}${cursor}${this.theme.dim(hint.slice(1))}`
    return ` ${content}${' '.repeat(Math.max(0, available - visibleWidth(content)))} `
  }
}
