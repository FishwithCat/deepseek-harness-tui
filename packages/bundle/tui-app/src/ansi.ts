/**
 * ANSI styling for the terminal surface and the pi-tui theme objects its
 * components require. Colour is opt-out through the conventional environment
 * switches, the palette follows the terminal background (dark by default, or
 * the light variant when the deployment selects one), and a disabled theme
 * returns text unchanged so rendering, width calculation, and tests stay
 * colour-independent.
 * @module @deepseek-ai/dsh-tui-app/ansi
 */

import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui'
import type { TuiColorScheme } from './config.ts'

/** One style: text in, styled text out, no state. */
export type Styler = (text: string) => string

/** Semantic styles the transcript, status bar, and prompts share. */
export interface TuiTheme {
  /** Human prompt text. */
  user: Styler
  /** Assistant message body. */
  assistant: Styler
  /** Provider reasoning text, shown while it streams. */
  reasoning: Styler
  /** Tool-call heading. */
  tool: Styler
  /** Successful tool outcome. */
  toolOk: Styler
  /** Failed tool outcome. */
  toolError: Styler
  /** Neutral app notice. */
  notice: Styler
  /** Failure notice. */
  error: Styler
  /** Approaching a budget the user still has room to act on. */
  warning: Styler
  /** Emphasis on a value or label. */
  accent: Styler
  /** Rules, separators, and other low-signal chrome. */
  border: Styler
  /** De-emphasized supporting text. */
  dim: Styler
  /** Bold text. */
  bold: Styler
  /** Italic text, the markdown emphasis face. */
  italic: Styler
  /** Added line of a file diff. */
  diffAdd: Styler
  /** Removed line of a file diff. */
  diffDel: Styler
  /** Unchanged context line of a file diff. */
  diffContext: Styler
  /** Diff chrome: a file header or a hunk boundary. */
  diffMeta: Styler
}

/** The palette a run resolves to. */
export type TuiPalette = 'dark' | 'light'

/** Construction facts for {@link createTheme}. */
export interface ThemeOptions {
  /** Whether ANSI styles are emitted. */
  enabled: boolean
  /** Palette the terminal background calls for. */
  palette: TuiPalette
}

/**
 * SGR parameters per role for one palette. `assistant` is absent because the
 * body inherits the terminal's own foreground, and `bold`/`italic` are the
 * scheme-independent attribute faces.
 */
interface PaletteSpec {
  user: string
  reasoning: string
  tool: string
  toolOk: string
  toolError: string
  notice: string
  error: string
  warning: string
  accent: string
  border: string
  dim: string
  diffAdd: string
  diffDel: string
  diffContext: string
  diffMeta: string
}

/** Palette for a dark terminal background (the default). */
const DARK: PaletteSpec = {
  user: '1;38;5;81',
  reasoning: '38;5;110',
  tool: '1;38;5;214',
  toolOk: '38;5;114',
  toolError: '1;38;5;203',
  notice: '38;5;245',
  error: '38;5;203',
  warning: '38;5;214',
  accent: '38;5;45',
  border: '38;5;240',
  dim: '38;5;243',
  diffAdd: '38;5;114',
  diffDel: '38;5;203',
  diffContext: '38;5;247',
  diffMeta: '1;38;5;45',
}

/** Palette for a light terminal background. */
const LIGHT: PaletteSpec = {
  user: '1;38;5;25',
  reasoning: '38;5;60',
  tool: '1;38;5;130',
  toolOk: '38;5;28',
  toolError: '1;38;5;124',
  notice: '38;5;240',
  error: '38;5;124',
  warning: '38;5;130',
  accent: '38;5;25',
  border: '38;5;250',
  dim: '38;5;245',
  diffAdd: '38;5;28',
  diffDel: '38;5;124',
  diffContext: '38;5;245',
  diffMeta: '1;38;5;25',
}

/**
 * Build one style from an SGR parameter list.
 * @param code - SGR parameters without the leading escape or trailing `m`.
 * @param enabled - whether colour and attributes are emitted.
 * @returns a styler that is the identity when disabled.
 */
function sgr(code: string, enabled: boolean): Styler {
  if (!enabled) return text => text
  return text => `\x1b[${code}m${text}\x1b[0m`
}

/**
 * Decide whether to emit ANSI styles for one output stream.
 * @param environment - the process environment (`NO_COLOR`, `FORCE_COLOR`, `TERM`).
 * @param isTty - whether that stream is a terminal.
 * @returns true when styled output is appropriate.
 */
export function supportsColor(environment: NodeJS.ProcessEnv, isTty: boolean): boolean {
  if ((environment.NO_COLOR ?? '') !== '') return false
  if ((environment.FORCE_COLOR ?? '') !== '') return true
  if (environment.TERM === 'dumb') return false
  return isTty
}

/**
 * Resolve the palette a run uses.
 *
 * `auto` reads `COLORFGBG`, the background signal xterm-family terminals
 * export as `foreground;background`; a background index of 7 or 15 selects the
 * light palette. An absent or unparseable value stays dark, because the dark
 * palette is the one every terminal can render legibly.
 * @param mode - the deployment's selection.
 * @param environment - the process environment.
 * @returns the palette to render with.
 */
export function resolveColorScheme(mode: TuiColorScheme, environment: NodeJS.ProcessEnv): TuiPalette {
  if (mode !== 'auto') return mode
  const background = /(\d+)\s*$/.exec(environment.COLORFGBG ?? '')?.[1]
  return background === '7' || background === '15' ? 'light' : 'dark'
}

/**
 * Build the surface theme.
 * @param options - whether styles are emitted and which palette to use.
 * @returns every semantic style the surface uses.
 */
export function createTheme(options: ThemeOptions): TuiTheme {
  const spec = options.palette === 'light' ? LIGHT : DARK
  const style = (code: string): Styler => sgr(code, options.enabled)
  return {
    user: style(spec.user),
    assistant: text => text,
    reasoning: style(spec.reasoning),
    tool: style(spec.tool),
    toolOk: style(spec.toolOk),
    toolError: style(spec.toolError),
    notice: style(spec.notice),
    error: style(spec.error),
    warning: style(spec.warning),
    accent: style(spec.accent),
    border: style(spec.border),
    dim: style(spec.dim),
    bold: sgr('1', options.enabled),
    italic: sgr('3', options.enabled),
    diffAdd: style(spec.diffAdd),
    diffDel: style(spec.diffDel),
    diffContext: style(spec.diffContext),
    diffMeta: style(spec.diffMeta),
  }
}

/**
 * Build the pi-tui select-list theme used by pickers and menus.
 * @param theme - the surface theme.
 * @returns the component's theme object.
 */
export function selectListTheme(theme: TuiTheme): SelectListTheme {
  return {
    selectedPrefix: theme.accent,
    selectedText: theme.bold,
    description: theme.dim,
    scrollInfo: theme.dim,
    noMatch: theme.dim,
  }
}

/**
 * Build the pi-tui composer theme.
 * @param theme - the surface theme.
 * @returns the component's theme object.
 */
export function editorTheme(theme: TuiTheme): EditorTheme {
  return {
    borderColor: theme.border,
    selectList: selectListTheme(theme),
  }
}

/**
 * Build the pi-tui markdown theme used for assistant message bodies.
 * @param theme - the surface theme.
 * @returns the component's theme object.
 */
export function markdownTheme(theme: TuiTheme): MarkdownTheme {
  return {
    heading: theme.bold,
    link: theme.accent,
    linkUrl: theme.dim,
    code: theme.accent,
    codeBlock: theme.assistant,
    codeBlockBorder: theme.border,
    quote: theme.dim,
    quoteBorder: theme.border,
    hr: theme.border,
    listBullet: theme.accent,
    bold: theme.bold,
    italic: theme.italic,
    strikethrough: theme.dim,
    underline: theme.accent,
  }
}
