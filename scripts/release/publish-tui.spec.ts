import { describe, expect, it } from 'vitest'
import { publishArgs } from './publish-tui.ts'

describe('publishArgs', () => {
  it('passes the required dist-tag before the optional provenance flag', () => {
    expect(publishArgs('/tmp/pkg.tgz', { provenance: true, tag: 'latest' })).toEqual([
      'publish',
      '/tmp/pkg.tgz',
      '--access',
      'public',
      '--tag',
      'latest',
      '--provenance',
    ])
  })

  it('omits provenance when it was not requested', () => {
    expect(publishArgs('/tmp/pkg.tgz', { provenance: false, tag: 'next' })).toEqual([
      'publish',
      '/tmp/pkg.tgz',
      '--access',
      'public',
      '--tag',
      'next',
    ])
  })

  it('appends the rehearsal flag last', () => {
    expect(publishArgs('/tmp/pkg.tgz', { provenance: true, tag: 'latest', dryRun: true })).toEqual([
      'publish',
      '/tmp/pkg.tgz',
      '--access',
      'public',
      '--tag',
      'latest',
      '--provenance',
      '--dry-run',
    ])
  })
})
