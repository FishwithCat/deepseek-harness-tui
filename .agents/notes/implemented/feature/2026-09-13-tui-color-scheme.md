# Agent Note: TUI colour scheme and legibility pass

Status: implemented

English | [中文](2026-09-13-tui-color-scheme.zh.md)

## Problem

The terminal surface had one flat palette in [`src/ansi.ts`](../../../../packages/bundle/tui-app/src/ansi.ts), built from single SGR parameter strings and tuned for a dark background. Several roles were hard to read: `dim` was the SGR 2 attribute alone, which many terminal themes render nearly invisible; reasoning text combined `2` (dim) with `3` (italic) and a grey, and italic is silently dropped by several terminals; markdown italics reused the reasoning style, so emphasis came out dim, italic, and grey. The empty composer had a visible defect on top of the taste problem: its cursor character was wrapped in `theme.dim`, and every styler ends with `\x1b[0m`, which cancels the `\x1b[7m` reverse video around it — the cursor block disappeared whenever colour was on. There was also no light-background palette, so a user on a light terminal got dark-background colours with no way to change them.

## Decision

**The palette becomes an explicit dark/light pair.** [`src/ansi.ts`](../../../../packages/bundle/tui-app/src/ansi.ts) holds one `PaletteSpec` per scheme. `TuiTheme` gains `italic` and the four diff styles (`diffAdd`, `diffDel`, `diffContext`, `diffMeta`); `createTheme` takes `{ enabled, palette }` instead of a bare boolean. `dim` becomes a real grey rather than the SGR 2 attribute, `reasoning` drops dim-and-italic for a muted colour, and markdown `italic` maps to the new dedicated style instead of borrowing the reasoning style.

**The scheme is a deployment setting, resolved explicitly.** `Config` gains `colorScheme: 'auto' | 'dark' | 'light'` (default `'auto'`), with `DSH_TUI_COLOR_SCHEME` supplying the default in the bundle patch, matching the existing `screen` field. `resolveColorScheme(mode, env)` returns an explicit selection unchanged and otherwise reads `COLORFGBG`, the `foreground;background` signal xterm-family terminals export: a background index of 7 or 15 selects light, and an absent or unparseable value stays dark. The resolution happens once at app construction, never inside a styler.

**The cursor character is not styled.** `PlaceholderEditor.placeholderLine` emits the reverse-video block around a bare character and dims only the remainder of the hint, so the block survives the surrounding styles.

## Alternatives considered

**Keep `dim` as SGR 2 and add colour only where it was missing.** It lost because the attribute is the least portable of the palette's signals — some themes map it below the contrast floor, and it composes badly with a coloured foreground, which is exactly where the surface uses it (footers, hints, argument summaries).

**Ship only the dark palette and leave light terminals to `NO_COLOR`.** It lost because `NO_COLOR` removes every distinction the surface encodes — errors, warnings, tool status — while a light palette keeps all of them; the config field is one validated value and one schema default.

**Fetch a real background from the terminal with an OSC 11 query.** It lost because it requires writing a request and reading its reply during app construction: the reply is asynchronous, may never arrive, and a terminal that ignores the query would stall boot. `COLORFGBG` is synchronous, widely exported, and its absence has a safe default.

**Reuse the Web client's `--dsw-*` theme tokens.** It lost because those are CSS custom properties with no 256-colour or ANSI form; mapping them would be a lossy conversion with no shared source of truth.

## Consequences

The terminal surface adapts to light and dark hosts and every semantic role has a deliberate face; the empty composer's cursor is visible again. The cost is one more config field, its generated-catalog entry, and a dark/light pair to keep in step when a role is added. Palette values stay a deliberate visual choice with no source of truth elsewhere in the repository, so the Agent Note pins only the structure — one spec per scheme, `resolveColorScheme`'s rule, and the roles — never the individual SGR numbers, which the tests do pin.

## Testing

`tests/ansi.spec.ts` pins the colour opt-out switches, `resolveColorScheme`'s explicit, light, dark, and malformed inputs, every role's dark and light value, the identity behaviour when styles are disabled, and the picker/composer/markdown mappings including `italic`. `tests/transcript.spec.ts` pins that the reverse-video cursor survives an enabled theme, and the status-bar escalation test now asserts the real `dim` grey. No model-visible, durable, or wire behaviour changes, so no recorded-session snapshot is affected; this surface has none.
