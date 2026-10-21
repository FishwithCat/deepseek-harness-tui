/**
 * Read-only history access for the watch viewer.
 *
 * History mode opens the persistence read handle only: it takes no write lock,
 * restores no Agent, and issues no model request.
 * @module @deepseek-ai/dsh-tui-app/watch/history
 */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

/** One stored session cut the viewer folds. */
export interface WatchHistory {
  /** Stored session header. */
  readonly header: SessionHeader
  /** Committed events in sequence order. */
  readonly events: readonly SessionEvent[]
}

/**
 * Read a stored child session without activating it.
 * @param ctx - context carrying the optional persistence service.
 * @param sessionId - the stored session to read.
 * @returns the header and every committed event.
 * @throws when persistence is unmounted, the session is absent, or the read fails.
 */
export async function readWatchHistory(ctx: Context, sessionId: string): Promise<WatchHistory> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) {
    throw new Error('this deployment stores no sessions, so there is no history to view')
  }
  const id = brandString<SessionId>(sessionId)
  const handle = await persistence.open(id, 'read')
  try {
    if (handle.header.id !== id) {
      throw new Error(`session persistence returned "${handle.header.id}" for "${sessionId}"`)
    }
    if (handle.header.origin !== 'subagent') {
      throw new Error(`session "${sessionId}" is not a subagent session`)
    }
    const result = await handle.read(0)
    return { header: handle.header, events: result.events }
  } finally {
    await handle.close()
  }
}
