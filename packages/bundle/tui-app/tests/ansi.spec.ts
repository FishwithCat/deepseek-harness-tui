/**
 * The surface palette: colour opt-out, scheme resolution, and the pi-tui
 * component themes built from the semantic styles.
 */

import { describe, expect, it } from 'vitest'
import { createTheme, editorTheme, markdownTheme, resolveColorScheme, selectListTheme, supportsColor } from '../src/ansi.ts'

describe('supportsColor', () => {
  it('honours the conventional opt-out and opt-in switches', () => {
    expect(supportsColor({ NO_COLOR: '1' }, true)).toBe(false)
    expect(supportsColor({ FORCE_COLOR: '1' }, false)).toBe(true)
    expect(supportsColor({ TERM: 'dumb' }, true)).toBe(false)
    expect(supportsColor({}, true)).toBe(true)
    expect(supportsColor({}, false)).toBe(false)
  })
})

describe('resolveColorScheme', () => {
  it('returns an explicit selection unchanged', () => {
    expect(resolveColorScheme('dark', { COLORFGBG: '0;15' })).toBe('dark')
    expect(resolveColorScheme('light', { COLORFGBG: '15;0' })).toBe('light')
  })

  it('reads the exported background signal and defaults to dark', () => {
    expect(resolveColorScheme('auto', { COLORFGBG: '15;0' })).toBe('dark')
    expect(resolveColorScheme('auto', { COLORFGBG: '0;15' })).toBe('light')
    expect(resolveColorScheme('auto', { COLORFGBG: '0;7' })).toBe('light')
    expect(resolveColorScheme('auto', { COLORFGBG: 'not-a-signal' })).toBe('dark')
    expect(resolveColorScheme('auto', {})).toBe('dark')
  })
})

describe('createTheme', () => {
  it('is the identity on every role when styles are disabled', () => {
    const theme = createTheme({ enabled: false, palette: 'dark' })
    expect(theme.user('text')).toBe('text')
    expect(theme.assistant('text')).toBe('text')
    expect(theme.reasoning('text')).toBe('text')
    expect(theme.tool('text')).toBe('text')
    expect(theme.toolOk('text')).toBe('text')
    expect(theme.toolError('text')).toBe('text')
    expect(theme.toolResult('text')).toBe('text')
    expect(theme.notice('text')).toBe('text')
    expect(theme.error('text')).toBe('text')
    expect(theme.warning('text')).toBe('text')
    expect(theme.accent('text')).toBe('text')
    expect(theme.border('text')).toBe('text')
    expect(theme.dim('text')).toBe('text')
    expect(theme.bold('text')).toBe('text')
    expect(theme.italic('text')).toBe('text')
    expect(theme.diffAdd('text')).toBe('text')
    expect(theme.diffDel('text')).toBe('text')
    expect(theme.diffContext('text')).toBe('text')
    expect(theme.diffMeta('text')).toBe('text')
  })

  it('emits the dark palette', () => {
    const theme = createTheme({ enabled: true, palette: 'dark' })
    expect(theme.user('x')).toBe('\x1b[1;38;5;81mx\x1b[0m')
    expect(theme.reasoning('x')).toBe('\x1b[38;5;110mx\x1b[0m')
    expect(theme.tool('x')).toBe('\x1b[1;38;5;214mx\x1b[0m')
    expect(theme.toolOk('x')).toBe('\x1b[38;5;114mx\x1b[0m')
    expect(theme.toolError('x')).toBe('\x1b[1;38;5;203mx\x1b[0m')
    expect(theme.toolResult('x')).toBe('\x1b[38;5;250mx\x1b[0m')
    expect(theme.notice('x')).toBe('\x1b[38;5;245mx\x1b[0m')
    expect(theme.error('x')).toBe('\x1b[38;5;203mx\x1b[0m')
    expect(theme.warning('x')).toBe('\x1b[38;5;214mx\x1b[0m')
    expect(theme.accent('x')).toBe('\x1b[38;5;45mx\x1b[0m')
    expect(theme.border('x')).toBe('\x1b[38;5;240mx\x1b[0m')
    expect(theme.dim('x')).toBe('\x1b[38;5;243mx\x1b[0m')
    expect(theme.bold('x')).toBe('\x1b[1mx\x1b[0m')
    expect(theme.italic('x')).toBe('\x1b[3mx\x1b[0m')
    expect(theme.diffAdd('x')).toBe('\x1b[38;5;114mx\x1b[0m')
    expect(theme.diffDel('x')).toBe('\x1b[38;5;203mx\x1b[0m')
    expect(theme.diffContext('x')).toBe('\x1b[38;5;247mx\x1b[0m')
    expect(theme.diffMeta('x')).toBe('\x1b[1;38;5;45mx\x1b[0m')
    expect(theme.assistant('x')).toBe('x')
  })

  it('emits the light palette', () => {
    const theme = createTheme({ enabled: true, palette: 'light' })
    expect(theme.user('x')).toBe('\x1b[1;38;5;25mx\x1b[0m')
    expect(theme.reasoning('x')).toBe('\x1b[38;5;60mx\x1b[0m')
    expect(theme.tool('x')).toBe('\x1b[1;38;5;130mx\x1b[0m')
    expect(theme.toolOk('x')).toBe('\x1b[38;5;28mx\x1b[0m')
    expect(theme.toolError('x')).toBe('\x1b[1;38;5;124mx\x1b[0m')
    expect(theme.toolResult('x')).toBe('\x1b[38;5;240mx\x1b[0m')
    expect(theme.notice('x')).toBe('\x1b[38;5;240mx\x1b[0m')
    expect(theme.error('x')).toBe('\x1b[38;5;124mx\x1b[0m')
    expect(theme.warning('x')).toBe('\x1b[38;5;130mx\x1b[0m')
    expect(theme.accent('x')).toBe('\x1b[38;5;25mx\x1b[0m')
    expect(theme.border('x')).toBe('\x1b[38;5;250mx\x1b[0m')
    expect(theme.dim('x')).toBe('\x1b[38;5;245mx\x1b[0m')
    expect(theme.diffAdd('x')).toBe('\x1b[38;5;28mx\x1b[0m')
    expect(theme.diffDel('x')).toBe('\x1b[38;5;124mx\x1b[0m')
    expect(theme.diffContext('x')).toBe('\x1b[38;5;245mx\x1b[0m')
    expect(theme.diffMeta('x')).toBe('\x1b[1;38;5;25mx\x1b[0m')
  })
})

describe('component themes', () => {
  it('maps the semantic styles onto the picker, composer, and markdown themes', () => {
    const theme = createTheme({ enabled: true, palette: 'dark' })
    expect(selectListTheme(theme)).toEqual({
      selectedPrefix: theme.accent,
      selectedText: theme.bold,
      description: theme.dim,
      scrollInfo: theme.dim,
      noMatch: theme.dim,
    })
    expect(editorTheme(theme)).toEqual({ borderColor: theme.border, selectList: selectListTheme(theme) })
    const markdown = markdownTheme(theme)
    expect(markdown.italic('emphasis')).toBe('\x1b[3memphasis\x1b[0m')
    expect(markdown.codeBlock('body')).toBe('body')
    expect(markdown.heading('title')).toBe(theme.bold('title'))
  })
})
