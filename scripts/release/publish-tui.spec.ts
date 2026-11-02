import { describe, expect, it } from 'vitest'
import { npmMajor, parseStageResult, publishArgs, requireStageNpm, stagePublishArgs } from './publish-tui.ts'

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

describe('stagePublishArgs', () => {
  it('asks npm for the stage id as JSON', () => {
    expect(stagePublishArgs('/tmp/pkg.tgz', { provenance: true, tag: 'latest' })).toEqual([
      'stage',
      'publish',
      '/tmp/pkg.tgz',
      '--access',
      'public',
      '--tag',
      'latest',
      '--json',
      '--provenance',
    ])
  })

  it('rehearses without provenance when it was not requested', () => {
    expect(stagePublishArgs('/tmp/pkg.tgz', { provenance: false, tag: 'next', dryRun: true })).toEqual([
      'stage',
      'publish',
      '/tmp/pkg.tgz',
      '--access',
      'public',
      '--tag',
      'next',
      '--json',
      '--dry-run',
    ])
  })
})

describe('npmMajor', () => {
  it('reads the major version from npm output', () => {
    expect(npmMajor('12.2.1\n')).toBe(12)
  })

  it('rejects output that is not a version', () => {
    expect(() => npmMajor('not a version')).toThrow('cannot read an npm version')
  })
})

describe('requireStageNpm', () => {
  it('accepts npm 12', () => {
    expect(() => {
      requireStageNpm(12)
    }).not.toThrow()
  })

  it('rejects npm 11', () => {
    expect(() => {
      requireStageNpm(11)
    }).toThrow('requires npm 12 or later')
  })
})

describe('parseStageResult', () => {
  it('reads the name, version, and stage id npm prints', () => {
    expect(parseStageResult(JSON.stringify({
      '@fishwithcat/dsh-agent': {
        id: '@fishwithcat/dsh-agent@0.2.2-alpha.2',
        name: '@fishwithcat/dsh-agent',
        version: '0.2.2-alpha.2',
        stageId: '5f0c2a6e-4d7b-4a1e-9c3d-2b8f6a1d0e4c',
      },
    }))).toEqual({
      name: '@fishwithcat/dsh-agent',
      version: '0.2.2-alpha.2',
      stageId: '5f0c2a6e-4d7b-4a1e-9c3d-2b8f6a1d0e4c',
    })
  })

  it('rejects output without a stage id', () => {
    expect(() => parseStageResult(JSON.stringify({
      '@fishwithcat/dsh-agent': {
        name: '@fishwithcat/dsh-agent',
        version: '0.2.2-alpha.2',
      },
    }))).toThrow('printed no stage id')
  })

  it('rejects output that is not one package record', () => {
    expect(() => parseStageResult('[]')).toThrow('did not print a JSON object')
    expect(() => parseStageResult('{}')).toThrow('printed no package record')
  })
})
