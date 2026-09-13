/**
 * The Host tool-presentation bridge: the diff card a Tool declares, narrowed
 * from the raw call and result the terminal surface folds.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { FileDiff } from '@deepseek-ai/dsh-tools'
import { createToolPresentationResolver } from '../src/tool-view.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/**
 * Build a context carrying the real Tool registry, which waits on the system
 * prompt service it injects.
 * @returns the context.
 */
async function registry(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

/** Register the mutation stub whose two cards are diff views. */
function registerMutate(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'mutate',
    description: 'Stub mutation.',
    parameters: { file_path: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: () => Promise.resolve('mutated'),
    presentCall: args => ({
      card: 'diff',
      title: `Mutate ${args.file_path}`,
      diffs: [{ path: args.file_path, oldText: 'old', newText: 'new' }],
    }),
    presentResult: (_args, result) => result.isError
      ? undefined
      : { card: 'diff', title: 'Mutated', diffs: [{ path: 'a', oldText: null, newText: 'applied' }] },
  }))
}

/** Register a tool whose only declared card is generic. */
function registerGeneric(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'generic',
    description: 'Stub generic.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: () => Promise.resolve('generic'),
    presentCall: () => ({ card: 'generic', title: 'Generic' }),
  }))
}

describe('createToolPresentationResolver', () => {
  it('narrows the pending and settled diff cards a Tool declares', async () => {
    const ctx = await registry()
    registerMutate(ctx)
    const resolver = createToolPresentationResolver(ctx, () => ({}))
    expect(resolver.call('mutate', '{"file_path":"src/a.ts"}')).toEqual({
      title: 'Mutate src/a.ts',
      diffs: [{ path: 'src/a.ts', oldText: 'old', newText: 'new' }],
    })
    expect(resolver.result('mutate', '{"file_path":"src/a.ts"}', {
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    })).toEqual({ title: 'Mutated', diffs: [{ path: 'a', oldText: null, newText: 'applied' }] })
  })

  it('declines every other card, an unknown tool, and a missing registry', async () => {
    const ctx = await registry()
    registerGeneric(ctx)
    const resolver = createToolPresentationResolver(ctx, () => ({}))
    expect(resolver.call('generic', '{}')).toBeUndefined()
    expect(resolver.call('missing', '{}')).toBeUndefined()

    const bare = new Context()
    contexts.push(bare)
    const withoutTools = createToolPresentationResolver(bare, () => ({}))
    expect(withoutTools.call('mutate', '{"file_path":"a"}')).toBeUndefined()
  })

  it('treats args that are not a JSON object as no card', async () => {
    const ctx = await registry()
    registerMutate(ctx)
    const resolver = createToolPresentationResolver(ctx, () => ({}))
    for (const args of ['', 'not json', '[1]', 'null', '"text"', '42']) {
      expect(resolver.call('mutate', args)).toBeUndefined()
    }
  })

  it('survives a presenter that throws on model-produced arguments', async () => {
    const ctx = await registry()
    ctx.tools.register(defineTool({
      name: 'explosive',
      description: 'Stub that throws.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: () => Promise.resolve('boom'),
      presentCall: () => { throw new Error('presenter defect') },
    }))
    const resolver = createToolPresentationResolver(ctx, () => ({}))
    expect(resolver.call('explosive', '{}')).toBeUndefined()
  })

  it('passes the settled result projection through to the Tool', async () => {
    const ctx = await registry()
    ctx.tools.register(defineTool({
      name: 'meta',
      description: 'Stub reading durable metadata.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: () => Promise.resolve('meta'),
      presentResult: (_args, result) => {
        const diffs = (result.meta as { diffs?: FileDiff[] } | undefined)?.diffs
        return diffs === undefined ? undefined : { card: 'diff', title: 'meta', diffs }
      },
    }))
    const resolver = createToolPresentationResolver(ctx, () => ({}))
    const meta = { diffs: [{ path: 'a', oldText: 'x', newText: 'y' }] }
    expect(resolver.result('meta', '{}', { content: [], isError: false, meta })).toEqual({
      title: 'meta',
      diffs: meta.diffs,
    })
    expect(resolver.result('meta', '{}', { content: [], isError: false })).toBeUndefined()
  })
})
