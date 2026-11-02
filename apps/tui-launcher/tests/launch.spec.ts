import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureTuiProfile,
  isVersionRequest,
  launcherCliArgs,
  resolveCliEntry,
  TUI_PROFILE_BUNDLES,
} from '../src/launch.ts'

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-tui-launcher-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('launcherCliArgs', () => {
  it('selects the tui profile and forwards application arguments', () => {
    expect(launcherCliArgs([])).toEqual(['--profile', 'tui'])
    expect(launcherCliArgs(['--resume', 'session-1', '--model', 'deepseek/flash']))
      .toEqual(['--profile', 'tui', '--resume', 'session-1', '--model', 'deepseek/flash'])
  })

  it('rejects both spellings of profile selection', () => {
    expect(() => launcherCliArgs(['--profile', 'web'])).toThrow(/fixed to "tui"/u)
    expect(() => launcherCliArgs(['--profile=web'])).toThrow(/fixed to "tui"/u)
    expect(() => launcherCliArgs(['--resume', 's', '--from-default-profile', 'web'])).toThrow(/fixed to "tui"/u)
  })

  it('rejects plugin management', () => {
    expect(() => launcherCliArgs(['plugin', 'add', 'pkg'])).toThrow(/dsh plugin --profile tui/u)
  })

  it('rewrites watch into the application flag', () => {
    expect(launcherCliArgs(['watch', 'session-2'])).toEqual(['--profile', 'tui', '--watch', 'session-2'])
    expect(launcherCliArgs(['watch', 'session-2', '--patch', 'x.yml']))
      .toEqual(['--profile', 'tui', '--watch', 'session-2', '--patch', 'x.yml'])
    expect(() => launcherCliArgs(['watch'])).toThrow(/watch needs a session id/u)
  })
})

describe('ensureTuiProfile', () => {
  it('creates the profile with the base and tui bundle layers', () => {
    const directory = join(temporaryDirectory(), 'profiles', 'tui')
    expect(ensureTuiProfile(directory)).toBe(directory)
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual([...TUI_PROFILE_BUNDLES])
  })

  it('leaves an existing profile and its user layer untouched', () => {
    const directory = join(temporaryDirectory(), 'profiles', 'tui')
    ensureTuiProfile(directory)
    const patch = join(directory, 'cordis.patch.yml')
    writeFileSync(patch, '# local edit\n')
    ensureTuiProfile(directory)
    expect(readFileSync(patch, 'utf8')).toBe('# local edit\n')
  })
})

describe('resolveCliEntry', () => {
  it('resolves the installed CLI bin', () => {
    const resolve = (specifier: string): string => `/opt/dsh/${specifier.replaceAll('/', '_')}.js`
    expect(resolveCliEntry(resolve)).toBe('/opt/dsh/@deepseek-ai_dsh_lib_bin.js.js')
  })
})

describe('isVersionRequest', () => {
  it('recognizes both version flags', () => {
    expect(isVersionRequest(['--profile', 'tui', '--version'])).toBe(true)
    expect(isVersionRequest(['--profile', 'tui', '-V'])).toBe(true)
    expect(isVersionRequest(['--profile', 'tui', '--resume', 's'])).toBe(false)
  })
})
