import { desc, eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { documentEvent, user } from '~/lib/db/schema'

export type DocumentHistoryEntry = {
  id: string
  kind: string
  fromValue: unknown
  toValue: unknown
  correlationId: string | null
  occurredAt: Date
  actorId: string | null
  actorName: string | null
}

// The `hard_delete` event's `toValue` carries the storage `pathname` so the bin
// audit trail can identify the destroyed byte. That key is an internal storage
// detail, not history any reader needs — strip it before the value leaves the
// service so the (protected, not admin-gated) history endpoint can't leak it.
function sanitizeValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'pathname' in value) {
    const { pathname: _pathname, ...rest } = value as Record<string, unknown>
    return rest
  }
  return value
}

/**
 * Read-side helper for the document history timeline. Writes stay inlined in
 * documentService for transaction locality (see ADR-0010); this module only
 * reads. Actor is left-joined because `actor_id` is `ON DELETE SET NULL`, so a
 * hard-deleted user leaves a history row with a null actor.
 */
export async function listForDocument(documentId: string): Promise<Array<DocumentHistoryEntry>> {
  const rows = await db
    .select({
      id: documentEvent.id,
      kind: documentEvent.kind,
      fromValue: documentEvent.fromValue,
      toValue: documentEvent.toValue,
      correlationId: documentEvent.correlationId,
      occurredAt: documentEvent.occurredAt,
      actorId: documentEvent.actorId,
      actorName: user.name,
    })
    .from(documentEvent)
    .leftJoin(user, eq(documentEvent.actorId, user.id))
    .where(eq(documentEvent.documentId, documentId))
    .orderBy(desc(documentEvent.occurredAt))
  return rows.map((row) => ({
    ...row,
    fromValue: sanitizeValue(row.fromValue),
    toValue: sanitizeValue(row.toValue),
  }))
}
