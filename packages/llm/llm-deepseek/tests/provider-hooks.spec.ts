/** Provider-owned connection readiness and model admission on the shared DeepSeek adapter. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context, LoggerLevel } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError } from '@deepseek-ai/dsh-llm'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { createModelListingCache, DeepSeekAdapter, registerDeepSeekProvider, resolveAdapterOptions } from '../src/index.ts'
import type { DeepSeekAdapterOptions, DeepSeekCatalogModel } from '../src/index.ts'
import { options as request, prepareExtensions } from './helpers.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

const endpoint = (models: DeepSeekCatalogModel[] = []) => resolveAdapterOptions({ baseURL: 'http://127.0.0.1:1', models })

async function route(hooks: Pick<DeepSeekAdapterOptions, 'connect' | 'admit'>) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin({
    name: 'fixture-route',
    inject: ['llm'],
    apply: (child: Context) => {
      registerDeepSeekProvider(child, 'fixture-route', {
        options: () => endpoint(), resolveAuth: () => Promise.resolve({ headers: {} }), ...hooks,
      })
    },
  })
  return ctx
}

it('resolves exact models and prepared calls from the asynchronous connection', async () => {
  const signals: Array<AbortSignal | undefined> = []
  const ctx = await route({
    connect: (signal) => {
      signals.push(signal)
      return Promise.resolve(endpoint([{ id: 'remote', contextWindow: 42 }]))
    },
  })
  await expect(ctx.llm.resolveModelInfo('fixture-route', 'remote')).resolves.toMatchObject({ context: { contextWindow: 42 } })
  const controller = new AbortController()
  await expect(ctx.llm.prepareCall({ provider: 'fixture-route', model: 'remote' }, controller.signal))
    .resolves.toMatchObject({ context: { contextWindow: 42 } })
  expect(signals).toContain(controller.signal)
})

it('refuses a model before a prepared call exists', async () => {
  const ctx = await route({
    admit: (_connection, model) => {
      if (model === 'blocked') throw new LlmError('blocked by fixture', 'CLIENT_UPGRADE_REQUIRED')
    },
  })
  await expect(ctx.llm.prepareCall({ provider: 'fixture-route', model: 'blocked' }))
    .rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' })
  await expect(ctx.llm.prepareCall({ provider: 'fixture-route', model: 'open' })).resolves.toBeDefined()
})

it('reports a successful listing load at debug level instead of stderr', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const logs: string[] = []
  ctx.logger.exporter({
    levels: { default: LoggerLevel.DEBUG },
    export: ({ type, args }) => { if (type === 'debug') logs.push(String(args[0])) },
  })
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const settings = { url: 'https://api.example/models', timeoutMs: 1_000, maxAgeMs: 0 }
    const cache = createModelListingCache(ctx, 'fixture-route', 'fixture-route', {
      settings: () => settings,
      credential: () => Promise.resolve('token'),
      load: () => Promise.resolve({ entries: [], skipped: 0 }),
    })
    await cache.view(settings)
    expect(logs).toContain('[fixture-route] model listing from https://api.example/models loaded 0 model(s), skipped 0 row(s)')
    expect(stderr).not.toHaveBeenCalled()
  } finally {
    stderr.mockRestore()
  }
})

it('refuses a model on a direct adapter stream', () => {
  const adapter = new DeepSeekAdapter({
    options: () => endpoint(),
    resolveAuth: () => Promise.resolve({ headers: {} }),
    resolveUserId: () => 'fixture-user' as AnonymousUserId,
    prepareExtensions,
    admit: () => { throw new LlmError('blocked by fixture', 'MODEL_UNSUPPORTED') },
  })
  expect(() => adapter.stream(request({ provider: 'fixture-route', model: 'blocked' }))).toThrow(/blocked by fixture/)
})
