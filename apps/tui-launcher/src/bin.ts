#!/usr/bin/env node
/* v8 ignore file -- self-executing entry; launch.ts owns the tested decisions. */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { constants } from 'node:os'
import { ensureTuiProfile, isVersionRequest, launcherCliArgs, resolveCliEntry } from './launch.ts'

/**
 * Stop the launcher with one stderr line.
 * @param message - diagnostic text.
 * @param code - process exit status.
 * @returns never.
 */
function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

const require = createRequire(import.meta.url)
const invocation = ((): { args: string[]; entry: string } => {
  try {
    const args = launcherCliArgs(process.argv.slice(2))
    if (!isVersionRequest(args)) ensureTuiProfile()
    return { args, entry: resolveCliEntry(require.resolve) }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), 1)
  }
})()

const child = spawn(process.execPath, [invocation.entry, ...invocation.args], {
  stdio: 'inherit',
  env: process.env,
})

// Ctrl+C reaches the child through the terminal's foreground process group;
// the parent ignores it so it stays alive to report the child's exit status.
process.on('SIGINT', () => {})
process.on('SIGTERM', () => { child.kill('SIGTERM') })
child.on('error', (error) => {
  fail(`dsh-tui: ${error.message}`, 1)
})
child.on('exit', (code, signal) => {
  if (signal !== null) process.exit(128 + constants.signals[signal])
  process.exit(code ?? 1)
})
