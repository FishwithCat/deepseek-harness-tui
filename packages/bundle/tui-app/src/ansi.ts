/**
 * ANSI styling for the terminal surface and the pi-tui theme objects its
 * components require. Colour is opt-out through the conventional environment
 * switches, and a disabled theme returns text unchanged so rendering, width
 * calculation, and tests stay colour-independent.
 * @module @deepseek-ai/dsh-tui-app/ansi
 */

import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui'

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
  /** Emphasis on a value or label. */
  accent: Styler
  /** Rules, separators, and other low-signal chrome. */
  border: Styler
  /** De-emphasized supporting text. */
  dim: Styler
  /** Bold text. */
  bold: Styler
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
 * Build the surface theme.
 * @param enabled - whether ANSI styles are emitted.
 * @returns every semantic style the surface uses.
 */
export function createTheme(enabled: boolean): TuiTheme {
  return {
    user: sgr('1;38;5;81', enabled),
    assistant: text => text,
    reasoning: sgr('2;3;38;5;245', enabled),
    tool: sgr('1;38;5;214', enabled),
    toolOk: sgr('38;5;78', enabled),
    toolError: sgr('1;38;5;203', enabled),
    notice: sgr('38;5;245', enabled),
    error: sgr('38;5;203', enabled),
    accent: sgr('38;5;45', enabled),
    border: sgr('38;5;240', enabled),
    dim: sgr('2', enabled),
    bold: sgr('1', enabled),
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
    italic: theme.reasoning,
    strikethrough: theme.dim,
    underline: theme.accent,
  }
}
