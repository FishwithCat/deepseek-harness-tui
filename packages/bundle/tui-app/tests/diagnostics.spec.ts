/**
 * Console capture while a terminal surface owns the screen: the formatted
 * message, its plain-text form, and restoration of every replaced method.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureConsole } from '../src/diagnostics.ts'

const restores: (() => void)[] = []

afterEach(() => {
  for (const restore of restores.splice(0)) restore()
})

/**
 * Install one capture whose writes this test reads.
 * @param writes - receives each message.
 * @returns the restore function, registered for teardown.
 */
function capture(writes: string[]): void {
  restores.push(captureConsole((text) => { writes.push(text) }))
}

describe('captureConsole', () => {
  it('reports every console method with the console formatting', () => {
    const writes: string[] = []
    capture(writes)
    console.debug('debug %s', 'one')
    console.info('info')
    console.log('log', 2)
    console.warn('warn')
    console.error('error %d', 3)
    expect(writes).toEqual(['debug one', 'info', 'log 2', 'warn', 'error 3'])
  })

  it('keeps terminal sequences and carriage returns out of the row', () => {
    const writes: string[] = []
    capture(writes)
    console.error('\u001b[31mred\u001b[39m\rnext\tcell\n\n')
    expect(writes).toEqual(['red\nnext cell'])
  })

  it('reports nothing for a blank message', () => {
    const writes: string[] = []
    capture(writes)
    console.log('\n')
    expect(writes).toEqual([])
  })

  it('restores every method and tolerates a repeated restore', () => {
    const originals = {
      debug: console.debug,
      info: console.info,
      log: console.log,
      warn: console.warn,
      error: console.error,
    }
    const restore = captureConsole(() => {})
    expect(console.log).not.toBe(originals.log)
    restore()
    restore()
    expect(console.debug).toBe(originals.debug)
    expect(console.info).toBe(originals.info)
    expect(console.log).toBe(originals.log)
    expect(console.warn).toBe(originals.warn)
    expect(console.error).toBe(originals.error)
  })

  it('forwards a call made through a method captured before the restore', () => {
    const writes: string[] = []
    const forward = vi.fn()
    const spy = vi.spyOn(console, 'error').mockImplementation(forward)
    try {
      const restore = captureConsole((text) => { writes.push(text) })
      const captured = console.error
      restore()
      captured('late')
      expect(forward).toHaveBeenCalledWith('late')
      expect(writes).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})
