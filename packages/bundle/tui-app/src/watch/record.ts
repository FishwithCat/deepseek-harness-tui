/**
 * Runtime connection records for local subagent watching.
 *
 * A record is disposable runtime data: it names the loopback origin, a random
 * token, and the service instance that wrote it. Records live in a private
 * directory under `$DSH_HOME/runtime/subagent-watch`, one file per child
 * session, and are never part of the Session format.
 * @module @deepseek-ai/dsh-tui-app/watch/record
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { encodeSessionRecordName, parseWatchConnectionRecord } from './protocol.ts'
import type { WatchConnectionRecord } from './protocol.ts'

/** Private directory holding published records. */
const RECORD_DIRECTORY = 'subagent-watch'
/** Owner-only permissions for the record directory. */
const DIRECTORY_MODE = 0o700
/** Owner-only permissions for one record file. */
const RECORD_MODE = 0o600

/**
 * Directory holding published connection records.
 * @returns the absolute runtime directory; it is resolved on every call so tests can change `$DSH_HOME`.
 */
export function watchRecordDirectory(): string {
  return dshHomePath('runtime', RECORD_DIRECTORY)
}

/**
 * Path of one session's record.
 * @param sessionId - the child session id.
 * @returns the absolute record path.
 */
export function watchRecordPath(sessionId: string): string {
  return join(watchRecordDirectory(), `${encodeSessionRecordName(sessionId)}.json`)
}

/**
 * Create the private record directory and remove permissions other users could
 * use to list or replace records.
 * @returns the directory path.
 */
async function ensureRecordDirectory(): Promise<string> {
  const directory = watchRecordDirectory()
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE })
  await chmod(directory, DIRECTORY_MODE)
  return directory
}

/**
 * Publish one record atomically with owner-only permissions.
 *
 * A temporary file in the same directory is written and renamed into place, so
 * a reader never observes a partial record.
 * @param record - the validated connection record.
 */
export async function publishWatchRecord(record: WatchConnectionRecord): Promise<void> {
  const directory = await ensureRecordDirectory()
  const target = join(directory, `${encodeSessionRecordName(record.sessionId)}.json`)
  const temporary = join(directory, `.${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
  const body = `${JSON.stringify(record)}\n`
  try {
    await writeFile(temporary, body, { mode: RECORD_MODE, flag: 'wx' })
    await chmod(temporary, RECORD_MODE)
    await rename(temporary, target)
    await chmod(target, RECORD_MODE)
  } catch (error: unknown) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * Read one published record.
 * @param sessionId - the child session id.
 * @returns the validated record, or undefined when no record was published.
 * @throws when the file exists but is unreadable, malformed, or for another protocol.
 */
export async function readWatchRecord(sessionId: string): Promise<WatchConnectionRecord | undefined> {
  let body: string
  try {
    body = await readFile(watchRecordPath(sessionId), 'utf8')
  } catch (error: unknown) {
    if (isMissingFile(error)) return undefined
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error: unknown) {
    throw new Error(`the watch connection record for "${sessionId}" is not valid JSON: ${errorMessage(error)}`)
  }
  const record = parseWatchConnectionRecord(parsed)
  if (record.sessionId !== sessionId) {
    throw new Error(`the watch connection record for "${sessionId}" names "${record.sessionId}"`)
  }
  return record
}

/**
 * Remove one record only when this service instance wrote it.
 * @param sessionId - the child session id.
 * @param serviceInstanceId - this service's identity.
 */
export async function removeOwnedWatchRecord(sessionId: SessionId, serviceInstanceId: string): Promise<void> {
  const record = await readWatchRecord(sessionId).catch(() => undefined)
  if (record === undefined || record.serviceInstanceId !== serviceInstanceId) return
  await rm(watchRecordPath(sessionId), { force: true })
}

/**
 * Remove every record this service instance published.
 * @param sessionIds - sessions this service published.
 * @param serviceInstanceId - this service's identity.
 */
export async function removeOwnedWatchRecords(
  sessionIds: Iterable<SessionId>,
  serviceInstanceId: string,
): Promise<void> {
  for (const sessionId of sessionIds) {
    await removeOwnedWatchRecord(sessionId, serviceInstanceId)
  }
}

/**
 * Whether a filesystem error reports an absent file.
 * @param error - the rejected value.
 * @returns true for ENOENT.
 */
function isMissingFile(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * Render an unknown rejection for a diagnostic.
 * @param error - the rejected value.
 * @returns its message or string form.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
