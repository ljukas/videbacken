import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { documentEvent, user } from '~/lib/db/schema'
import * as documentService from '~/lib/services/document'
import { setupDatabase } from '~test/setup'
import { listForDocument } from './documentEvent'

setupDatabase()

async function insertMember(email: string, name = email, role: 'user' | 'admin' = 'user') {
  const [row] = await db.insert(user).values({ name, email, role }).returning({ id: user.id })
  return row.id
}

test('listForDocument returns events newest-first with the actor name joined', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const inserted = await documentService.confirmUpload({
    ownerId,
    pathname: `dev/documents/${crypto.randomUUID()}/m.pdf`,
    name: 'm.pdf',
    mime: 'application/pdf',
    sizeBytes: 100,
  })
  // newName is the base only; the '.pdf' extension is immutable. The event
  // records the human-readable display name (base + extension).
  await documentService.renameDocument({
    id: inserted.document.id,
    newName: 'minutes',
    actorId: ownerId,
    actorRole: 'user',
  })

  const history = await listForDocument(inserted.document.id)
  expect(history.map((e) => e.kind)).toEqual(['rename', 'upload'])
  expect(history[0].actorName).toBe('Anna')
  expect(history[0].toValue).toEqual({ name: 'minutes.pdf' })
  expect(history[1].toValue).toEqual({ name: 'm.pdf', folderId: null })
})

test('listForDocument returns [] for a document with no events', async () => {
  expect(await listForDocument('00000000-0000-0000-0000-000000000000')).toEqual([])
})

test('listForDocument strips the storage pathname from event payloads', async () => {
  const ownerId = await insertMember('anna@test.oceanview.local', 'Anna')
  const inserted = await documentService.confirmUpload({
    ownerId,
    pathname: `dev/documents/${crypto.randomUUID()}/m.pdf`,
    name: 'm.pdf',
    mime: 'application/pdf',
    sizeBytes: 100,
  })
  // Synthesize a hard_delete-shaped event whose toValue still carries the
  // storage pathname. (In practice the FK nulls document_id on hard-delete, so
  // it can't reach listForDocument — the strip is defense-in-depth.)
  await db.insert(documentEvent).values({
    documentId: inserted.document.id,
    actorId: ownerId,
    kind: 'hard_delete',
    toValue: { name: 'm.pdf', pathname: inserted.file.pathname },
  })

  const history = await listForDocument(inserted.document.id)
  const hardDelete = history.find((e) => e.kind === 'hard_delete')
  expect(hardDelete?.toValue).toEqual({ name: 'm.pdf' })
})
