/**
 * Install the published terminal distribution into a throwaway prefix and
 * drive it without a terminal.
 *
 * This is the post-publish acceptance for the npm path: it proves the
 * launcher's aliases resolve to the fork's packages, that npm keeps one copy
 * of the aliased core, and that the created profile boots the installed CLI.
 * `--version` must not create a profile; `--help` must boot the TUI bundle and
 * print its help.
 *
 * @module scripts/release/verify-tui-install
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { valid } from 'semver'
import { forkBase, TUI_SCOPE } from './pack-tui.ts'
import { attemptEchoed, capture } from './process.ts'

/** Path of the installed launcher entry inside an npm prefix. */
export function launcherEntry(prefix: string): string {
  return join(prefix, 'node_modules', ...TUI_SCOPE.split('/'), 'dsh-tui', 'lib', 'bin.js')
}

/** Path of the aliased agent package inside an npm prefix. */
export function aliasedAgent(prefix: string): string {
  return join(prefix, 'node_modules', '@deepseek-ai', 'dsh-agent', 'package.json')
}

/** Path of the aliased CLI package inside an npm prefix. */
export function aliasedCli(prefix: string): string {
  return join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
}

/** Path of the installed launcher manifest inside an npm prefix. */
export function launcherManifest(prefix: string): string {
  return join(prefix, 'node_modules', ...TUI_SCOPE.split('/'), 'dsh-tui', 'package.json')
}

/**
 * Count the installed `@deepseek-ai/dsh-agent` copies.
 * @param prefix - npm install prefix.
 * @returns the parseable paths npm reports.
 */
export function agentCopies(prefix: string): string[] {
  const output = capture('npm', ['ls', '--prefix', prefix, '@deepseek-ai/dsh-agent', '--all', '--parseable'])
  return output.split(/\r?\n/u).filter(line => line !== '')
}

/** Install the published launcher and exercise it. */
function main(): void {
  const argv = process.argv.slice(2)
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      keep: { type: 'boolean' },
    },
    allowPositionals: false,
    args: argv[0] === '--' ? argv.slice(1) : argv,
  })
  const version = values.version
  if (version === undefined) throw new Error('verify-tui-install: pass --version <published-version>')
  if (valid(version) === null) {
    throw new Error(`verify-tui-install: ${JSON.stringify(version)} is not a single published version`)
  }
  const base = forkBase(version)

  const prefix = mkdtempSync(join(tmpdir(), 'dsh-tui-install-'))
  const home = join(prefix, '.dsh')
  try {
    const install = attemptEchoed('npm', [
      'install',
      '--prefix', prefix,
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      `${TUI_SCOPE}/dsh-tui@${version}`,
    ])
    if (install.status !== 0) {
      throw new Error(`verify-tui-install: npm install exited with ${String(install.status)}`)
    }

    const copies = agentCopies(prefix)
    if (copies.length !== 1) {
      throw new Error(`verify-tui-install: expected one @deepseek-ai/dsh-agent, found ${String(copies.length)}:\n${copies.join('\n')}`)
    }
    const agent = JSON.parse(readFileSync(aliasedAgent(prefix), 'utf8')) as { name: string; version: string }
    if (agent.name !== `${TUI_SCOPE}/dsh-agent` || agent.version !== base) {
      throw new Error(`verify-tui-install: agent resolves to ${agent.name}@${agent.version}`)
    }
    const cli = JSON.parse(readFileSync(aliasedCli(prefix), 'utf8')) as { name: string; version: string }
    if (cli.name !== `${TUI_SCOPE}/dsh` || cli.version !== version) {
      throw new Error(`verify-tui-install: CLI resolves to ${cli.name}@${cli.version}`)
    }
    const launcher = JSON.parse(readFileSync(launcherManifest(prefix), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const dependencies = launcher.dependencies ?? {}
    if (dependencies['@deepseek-ai/dsh'] !== `npm:${TUI_SCOPE}/dsh@${version}`) {
      throw new Error(`verify-tui-install: launcher pins the CLI as ${String(dependencies['@deepseek-ai/dsh'])}`)
    }
    if (dependencies['@deepseek-ai/dsh-agent'] !== `npm:${TUI_SCOPE}/dsh-agent@${base}`) {
      throw new Error(`verify-tui-install: launcher pins the agent as ${String(dependencies['@deepseek-ai/dsh-agent'])}`)
    }

    const environment = { ...process.env, DSH_HOME: home }
    const printed = capture(process.execPath, [launcherEntry(prefix), '--version'], { env: environment })
    if (printed !== version) throw new Error(`verify-tui-install: --version printed ${printed}`)
    if (existsSync(join(home, 'profiles', 'tui'))) {
      throw new Error('verify-tui-install: --version created the tui profile')
    }

    const help = capture(process.execPath, [launcherEntry(prefix), '--help'], { env: environment })
    if (!help.includes('Open the interactive terminal UI')) {
      throw new Error('verify-tui-install: --help did not boot the TUI bundle')
    }
    if (!existsSync(join(home, 'profiles', 'tui', 'package.json'))) {
      throw new Error('verify-tui-install: --help did not create the tui profile')
    }

    console.log(`verify-tui-install: ${version} installed with one aliased agent copy`)
  } finally {
    if (values.keep !== true) rmSync(prefix, { recursive: true, force: true })
  }
}

if (import.meta.main) main()
