/**
 * The transcript fold: durable Session events and live Assistant frames into
 * the rows the terminal renders.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { LlmAttemptId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionSeq } from '@deepseek-ai/dsh-session'
import { Transcript } from '../src/transcript.ts'
import { TranscriptView, summarizeToolArguments } from '../src/views.ts'
import { createTheme } from '../src/ansi.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/**
 * Create a store-backed session whose events the transcript can fold.
 * @returns the live session.
 */
async function makeSession() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  return ctx.sessions.create()
}

/**
 * Build one live Assistant chunk frame.
 * @param revision - the frame revision.
 * @param index - the dense chunk position.
 * @param chunk - the provider chunk.
 * @returns the published frame.
 */
function chunkFrame(revision: number, index: number, chunk: StreamChunk): AssistantStreamFrame {
  return { type: 'chunk', attemptId: LlmAttemptId('attempt'), revision, index, time: index, chunk }
}

describe('Transcript', () => {
  it('renders the human prompt, assistant text, and tool outcome in log order', async () => {
    const session = await makeSession()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'list the files' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'Listing now.' }],
        source: { provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: 'call-1' as ToolCallId, name: 'bash', arguments: '{"command":"ls"}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: 'call-1' as ToolCallId,
        content: [{ type: 'text', text: 'a.ts\nb.ts' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const transcript = new Transcript()
    for (const event of session.ownEvents()) expect(typeof transcript.applyEvent(event)).toBe('boolean')

    const entries = transcript.entries()
    expect(entries.map(entry => entry.kind)).toEqual(['user', 'assistant', 'tool'])
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'list the files' })
    expect(entries[1]).toMatchObject({ kind: 'assistant', text: 'Listing now.' })
    expect(entries[2]).toMatchObject({ kind: 'tool', name: 'bash', status: 'ok', result: 'a.ts\nb.ts' })
  })

  it('accumulates live deltas and replaces them with the durable settlement', async () => {
    const session = await makeSession()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const transcript = new Transcript()
    let folded = 0
    const foldNew = (): void => {
      const events = session.ownEvents()
      for (; folded < events.length; folded++) {
        const event = events[folded]
        if (event === undefined) throw new Error('event index out of range')
        transcript.applyEvent(event)
      }
    }
    foldNew()
    expect(transcript.applyFrame({ type: 'start', attemptId: LlmAttemptId('attempt'), revision: 1, turn: 1, step: 1 })).toBe(true)
    expect(transcript.streaming).toBe(true)
    transcript.applyFrame(chunkFrame(2, 0, { type: 'reasoning-delta', index: 0, text: 'thinking' }))
    transcript.applyFrame(chunkFrame(3, 1, { type: 'text-delta', index: 0, text: 'Hel' }))
    transcript.applyFrame(chunkFrame(4, 2, { type: 'text-delta', index: 0, text: 'lo' }))
    transcript.applyFrame(chunkFrame(5, 3, { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }))
    expect(transcript.usage).toEqual({ inputTokens: 3, outputTokens: 2 })
    expect(transcript.entries().map(entry => entry.kind)).toEqual(['user', 'reasoning', 'assistant'])
    expect(transcript.entries().at(-1)).toMatchObject({ kind: 'assistant', text: 'Hello' })

    session.append('assistant/message', {
      turn: 1,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'Hello' }],
        source: { provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append' })
    foldNew()
    transcript.applyFrame({
      type: 'end',
      attemptId: LlmAttemptId('attempt'),
      revision: 6,
      index: 4,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: SessionSeq(session.seq - 1) },
    })
    expect(transcript.streaming).toBe(false)
    // The live rows are gone; only the durable settlement remains.
    expect(transcript.entries().map(entry => entry.kind)).toEqual(['user', 'assistant'])
  })

  it('reports a failed attempt and an errored turn as notices', async () => {
    const session = await makeSession()
    const stream: AssistantStreamRecord[] = [{
      type: 'chunk',
      time: 0,
      chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded', code: 'E' } } },
    }]
    session.append('turn/start', { turn: 1 })
    session.append('assistant/attempt', { turn: 1, step: 1, stream })

    const transcript = new Transcript()
    for (const event of session.ownEvents()) transcript.applyEvent(event)
    expect(transcript.entries().at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: 'provider exploded' })

    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    const closer = session.ownEvents().at(-1)
    if (closer === undefined) throw new Error('expected the turn closer to be appended')
    transcript.applyEvent(closer)
    expect(transcript.entries().at(-1)).toMatchObject({ kind: 'notice', level: 'info', text: 'turn cancelled' })
  })

  it('clears every row on reset', async () => {
    const session = await makeSession()
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const transcript = new Transcript()
    for (const event of session.ownEvents()) transcript.applyEvent(event)
    expect(transcript.entries()).toHaveLength(1)
    transcript.reset()
    expect(transcript.entries()).toHaveLength(0)
  })
})

describe('TranscriptView', () => {
  it('keeps every rendered line inside the viewport width', async () => {
    const session = await makeSession()
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'a very long prompt '.repeat(12) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const transcript = new Transcript()
    for (const event of session.ownEvents()) transcript.applyEvent(event)
    const view = new TranscriptView(transcript, createTheme(false))
    for (const line of view.render(40)) {
      expect(line.length).toBeLessThanOrEqual(40)
    }
  })

  it('folds a long tool result and summarizes its arguments', async () => {
    const session = await makeSession()
    const callId = 'call-1' as ToolCallId
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{"command":"printf x"}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: Array.from({ length: 40 }, (_, index) => `line ${String(index)}`).join('\n') }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    const transcript = new Transcript()
    for (const event of session.ownEvents()) transcript.applyEvent(event)
    const view = new TranscriptView(transcript, createTheme(false))
    const rendered = view.render(60).join('\n')
    expect(rendered).toContain('command=printf x')
    expect(rendered).toContain('more lines')
  })
})

describe('summarizeToolArguments', () => {
  it('prefers a known key, falls back to pairs, and passes invalid JSON through', () => {
    expect(summarizeToolArguments('{"command":"ls -la"}')).toBe('command=ls -la')
    expect(summarizeToolArguments('{"alpha":1,"beta":"two"}')).toBe('alpha=1 beta=two')
    expect(summarizeToolArguments('not json')).toBe('not json')
    expect(summarizeToolArguments('')).toBe('')
  })
})
