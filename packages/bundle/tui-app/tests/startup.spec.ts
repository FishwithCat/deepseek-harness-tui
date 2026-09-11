/**
 * The terminal app's command-line provider over a real Loader tree: the flags
 * become the injected TUI invocation, while help and usage errors leave the
 * consumer pending.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, TUI_STARTUP_SERVICE, type TuiStartupValues } from '../src/startup.ts'

/** What one fixture boot observed. */
interface Observed {
  exits: number[]
  out: string
  consumerConfig?: unknown
}

const disposers: (() => Promise<void>)[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/**
 * Mount the real provider over a TUI-row stand-in.
 * @param args - the invocation's inner arguments.
 * @returns the published values and the observed consumer/process effects.
 */
async function bootStartup(args: string[]): Promise<{ values: TuiStartupValues | undefined; observed: Observed }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-startup-'))
  tempDirs.push(dir)
  const observed: Observed = { exits: [], out: '' }
  writeFileSync(join(dir, 'row.mjs'), 'export function apply(_ctx, config) { globalThis.__tuiStartupObserved.consumerConfig = config }\n')
  // Loader imports through Node's resolver, so this fixture delegates to the
  // source-plane plugin already imported by the test.
  writeFileSync(join(dir, 'startup.mjs'), `
export const name = 'tui-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__tuiStartupApply(ctx)
`)
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: tui-row',
    `  name: ${pathToFileURL(join(dir, 'row.mjs')).href}`,
    `  inject: [${TUI_STARTUP_SERVICE}]`,
    '  config:',
    '    resume: !!js ctx.tuiStartup.resume',
    '- id: tui-startup',
    `  name: ${pathToFileURL(join(dir, 'startup.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  const globals = globalThis as unknown as {
    __tuiStartupApply: typeof apply
    __tuiStartupObserved: Observed
  }
  globals.__tuiStartupApply = apply
  globals.__tuiStartupObserved = observed

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return {
    values: ctx.get(TUI_STARTUP_SERVICE) as TuiStartupValues | undefined,
    observed,
  }
}

describe('tui command-line provider', () => {
  it('publishes an empty invocation for a bare launch and feeds the consumer row', async () => {
    const { values, observed } = await bootStartup([])
    expect(values).toEqual({})
    expect(observed.consumerConfig).toEqual({})
    expect(observed.exits).toEqual([])
  })

  it('publishes the resume target and the explicit route', async () => {
    const { values } = await bootStartup(['--resume', 'session-1', '--provider', 'p', '--model', 'm'])
    expect(values).toEqual({ resume: 'session-1', provider: 'p', model: 'm' })
  })

  it('rejects a half-specified route without publishing', async () => {
    const { values, observed } = await bootStartup(['--model', 'm'])
    expect(observed.out).toContain('--provider and --model must be given together')
    expect(values).toBeUndefined()
    expect(observed.consumerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('prints its own help and leaves the consumer pending', async () => {
    const { values, observed } = await bootStartup(['--help'])
    expect(observed.out).toContain('dsh --profile tui')
    expect(observed.out).toContain('Open the interactive terminal UI')
    expect(values).toBeUndefined()
    expect(observed.consumerConfig).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })
})
