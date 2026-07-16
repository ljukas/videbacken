import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { ownershipAssignment, user } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import type { ShareDomainError } from './errors'
import {
  assignShareAsAdmin,
  getCurrentOwner,
  listCurrentSharesForUser,
  listShareHistory,
  listSharesWithCurrentOwner,
  unassignShareAsAdmin,
} from './share'

setupDatabase()

async function seedUsers(...names: Array<string>): Promise<Array<string>> {
  const rows = await db
    .insert(user)
    .values(names.map((name) => ({ name, email: `${name.toLowerCase()}@test.oceanview.local` })))
    .returning({ id: user.id })
  return rows.map((r) => r.id)
}

test('getCurrentOwner returns null when the share has never been assigned', async () => {
  expect(await getCurrentOwner('A')).toBeNull()
})

test('assignShareAsAdmin creates an active assignment and records the actor', async () => {
  const [aliceId, adminId] = await seedUsers('Alice', 'Admin')

  await assignShareAsAdmin(
    { shareCode: 'A', userId: aliceId, from: new Date('2024-01-01') },
    { actorUserId: adminId },
  )

  expect(await getCurrentOwner('A')).toBe(aliceId)
  const history = await listShareHistory('A')
  expect(history).toHaveLength(1)
  expect(history[0]).toMatchObject({
    shareCode: 'A',
    userId: aliceId,
    actorUserId: adminId,
    assignedTo: null,
  })
})

test('reassigning closes the prior stint on the new from date (half-open)', async () => {
  const [aliceId, bobId] = await seedUsers('Alice', 'Bob')

  await assignShareAsAdmin({ shareCode: 'A', userId: aliceId, from: new Date('2024-01-01') })
  await assignShareAsAdmin({ shareCode: 'A', userId: bobId, from: new Date('2025-01-01') })

  expect(await getCurrentOwner('A')).toBe(bobId)

  const history = await listShareHistory('A')
  expect(history).toHaveLength(2)
  // Newest first; prior stint closed exactly at the new from date.
  expect(history[0]).toMatchObject({ userId: bobId, assignedTo: null })
  expect(history[1].userId).toBe(aliceId)
  expect(history[1].assignedTo?.toISOString().slice(0, 10)).toBe('2025-01-01')
})

test('assignShareAsAdmin rejects assigning to the current owner', async () => {
  const [aliceId] = await seedUsers('Alice')
  await assignShareAsAdmin({ shareCode: 'B', userId: aliceId, from: new Date('2024-01-01') })

  await expect(
    assignShareAsAdmin({ shareCode: 'B', userId: aliceId, from: new Date('2025-01-01') }),
  ).rejects.toMatchObject({ code: 'ALREADY_CURRENT_OWNER' } satisfies Partial<ShareDomainError>)
})

test('assignShareAsAdmin rejects a from-date not after the current assignedFrom', async () => {
  const [aliceId, bobId] = await seedUsers('Alice', 'Bob')
  await assignShareAsAdmin({ shareCode: 'C', userId: aliceId, from: new Date('2024-06-01') })

  await expect(
    assignShareAsAdmin({ shareCode: 'C', userId: bobId, from: new Date('2024-06-01') }),
  ).rejects.toMatchObject({
    code: 'FROM_DATE_NOT_AFTER_CURRENT',
  } satisfies Partial<ShareDomainError>)
})

test('assignShareAsAdmin rejects an unknown user', async () => {
  await expect(
    assignShareAsAdmin({
      shareCode: 'D',
      userId: '00000000-0000-0000-0000-000000000000',
      from: new Date('2024-01-01'),
    }),
  ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' } satisfies Partial<ShareDomainError>)
})

test('listSharesWithCurrentOwner returns all 10 shares A→J with owners left-joined', async () => {
  const [aliceId] = await seedUsers('Alice')
  await assignShareAsAdmin({ shareCode: 'D', userId: aliceId, from: new Date('2024-01-01') })

  const rows = await listSharesWithCurrentOwner()
  expect(rows).toHaveLength(10)
  expect(rows.map((r) => r.shareCode)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'])
  expect(rows.find((r) => r.shareCode === 'D')?.currentUserId).toBe(aliceId)
  expect(rows.find((r) => r.shareCode === 'E')?.currentUserId).toBeNull()
})

test('listCurrentSharesForUser returns owned share codes sorted A→J', async () => {
  const [aliceId] = await seedUsers('Alice')
  await assignShareAsAdmin({ shareCode: 'G', userId: aliceId, from: new Date('2024-01-01') })
  await assignShareAsAdmin({ shareCode: 'B', userId: aliceId, from: new Date('2024-01-01') })

  expect(await listCurrentSharesForUser(aliceId)).toEqual(['B', 'G'])
})

test('unassignShareAsAdmin closes the stint and preserves history', async () => {
  const [aliceId] = await seedUsers('Alice')
  await assignShareAsAdmin({ shareCode: 'E', userId: aliceId, from: new Date('2024-01-01') })

  await unassignShareAsAdmin({ shareCode: 'E', on: new Date('2024-06-30') })

  expect(await getCurrentOwner('E')).toBeNull()
  const history = await listShareHistory('E')
  expect(history).toHaveLength(1)
  expect(history[0].assignedTo?.toISOString().slice(0, 10)).toBe('2024-06-30')
})

test('a share can be reassigned after an unassign gap', async () => {
  const [aliceId, bobId] = await seedUsers('Alice', 'Bob')
  await assignShareAsAdmin({ shareCode: 'F', userId: aliceId, from: new Date('2024-01-01') })
  await unassignShareAsAdmin({ shareCode: 'F', on: new Date('2024-06-30') })
  await assignShareAsAdmin({ shareCode: 'F', userId: bobId, from: new Date('2025-01-01') })

  expect(await getCurrentOwner('F')).toBe(bobId)
  expect(await listShareHistory('F')).toHaveLength(2)
})

test('unassignShareAsAdmin throws NOT_ASSIGNED when the share has no active stint', async () => {
  await expect(
    unassignShareAsAdmin({ shareCode: 'H', on: new Date('2024-06-30') }),
  ).rejects.toMatchObject({ code: 'NOT_ASSIGNED' } satisfies Partial<ShareDomainError>)
})

test('unassignShareAsAdmin rejects a date not after the current assignedFrom', async () => {
  const [aliceId] = await seedUsers('Alice')
  await assignShareAsAdmin({ shareCode: 'I', userId: aliceId, from: new Date('2024-01-01') })

  await expect(
    unassignShareAsAdmin({ shareCode: 'I', on: new Date('2024-01-01') }),
  ).rejects.toMatchObject({ code: 'DATE_NOT_AFTER_CURRENT' } satisfies Partial<ShareDomainError>)
})

test('partial unique index forbids two simultaneously-open assignments for one share', async () => {
  const [aliceId, bobId] = await seedUsers('Alice', 'Bob')

  await db.insert(ownershipAssignment).values({
    shareCode: 'G',
    userId: aliceId,
    assignedFrom: new Date('2024-01-01'),
    assignedTo: null,
  })

  await expect(
    db.insert(ownershipAssignment).values({
      shareCode: 'G',
      userId: bobId,
      assignedFrom: new Date('2024-06-01'),
      assignedTo: null,
    }),
  ).rejects.toThrow()
})
