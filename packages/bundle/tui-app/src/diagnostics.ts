/**
 * Console capture for a surface that owns the terminal.
 *
 * A full-screen TUI writes its frame through the terminal object, so a
 * `console` call reaches the same device outside the renderer. The text lands on
 * whatever row the cursor occupies, and the differential renderer leaves it
 * there until that row's own content changes. The capture replaces the console
 * methods for the lifetime of the surface and hands each formatted write to a
 * sink that puts it where the renderer controls it.
 * @module @deepseek-ai/dsh-tui-app/diagnostics
 */

import { format } from 'node:util'
import { stripTerminalSequences } from '@earendil-works/pi-tui'

/** Console methods replaced until the surface restores the terminal. */
const CAPTURED_METHODS = ['debug', 'info', 'log', 'warn', 'error'] as const

/** One replaced console method. */
type CapturedMethod = typeof CAPTURED_METHODS[number]

/**
 * Make console text safe for a renderer-owned row.
 *
 * Terminal sequences would restyle or move the frame, and a carriage return
 * would overwrite its own line. Line breaks stay because a notice renders a
 * multi-line diagnostic; trailing breaks would spend an empty row.
 * @param text - the formatted console message.
 * @returns the message as plain row text.
 */
function renderable(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\n+$/u, '')
}

/**
 * Replace the process console methods until the returned function restores them.
 *
 * The wrapper formats arguments the way the console would have printed them and
 * never writes to the terminal itself. It is installed before the renderer
 * starts and removed after the renderer has restored the screen, so its sink
 * runs only while the surface owns the terminal.
 * @param sink - receives each plain-text message; an empty message reports nothing.
 * @returns the idempotent restore function.
 */
export function captureConsole(sink: (text: string) => void): () => void {
  const originals = new Map<CapturedMethod, (...data: unknown[]) => void>()
  let restored = false
  for (const method of CAPTURED_METHODS) {
    const original = console[method]
    originals.set(method, original)
    console[method] = (...args: unknown[]) => {
      // A write racing the restore belongs to the console, not to a surface
      // that has already handed the terminal back.
      if (restored) {
        original.apply(console, args)
        return
      }
      const text = renderable(format(...args))
      if (text !== '') sink(text)
    }
  }
  return () => {
    if (restored) return
    restored = true
    for (const [method, original] of originals) console[method] = original
  }
}
