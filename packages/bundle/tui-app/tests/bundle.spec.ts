/** The terminal app bundle's declared profile patch. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('dsh-tui-app bundle', () => {
  it('keeps Session-log upload off and inserts the terminal rows', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const patches = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    ) as Array<{ id?: string; config?: Record<string, unknown>; insert?: Array<{ id?: string; name?: string; inject?: string[] }> }>
    expect(patches.find(patch => patch.id === 'session-log-deepseek')?.config).toMatchObject({ enabled: false })
    const rows = patches.flatMap(patch => patch.insert ?? [])
    expect(rows.find(row => row.id === 'session-stats')?.name).toBe('@deepseek-ai/dsh-session-stats')
    expect(rows.find(row => row.id === 'tui-startup')?.name).toBe('@deepseek-ai/dsh-tui-app/startup')
    expect(rows.find(row => row.id === 'tui-app')?.inject).toEqual(['tuiStartup'])
  })
})
