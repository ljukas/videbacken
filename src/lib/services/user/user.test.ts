import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { user } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import { UserDomainError } from './errors'
import {
  assertInviteResendable,
  completeOnboarding,
  countAdmins,
  findActiveById,
  findAvatarByEmail,
  findIdByEmail,
  findRowById,
  inviteUser,
  listAll,
  listDeleted,
  markInvited,
  restoreAsAdmin,
  setImage,
  softDeleteAsAdmin,
  updateAsAdmin,
  updateOwnProfile,
} from './user'

setupDatabase()

const standardInput = {
  name: 'Anna Svensson',
  phone: '070-111 22 33',
  role: 'user' as const,
}

async function insertAdmin(email: string, name = email) {
  const [row] = await db
    .insert(user)
    .values({ name, email, role: 'admin' })
    .returning({ id: user.id })
  return row.id
}

async function insertMember(email: string, name = email) {
  const [row] = await db
    .insert(user)
    .values({ name, email, role: 'user' })
    .returning({ id: user.id })
  return row.id
}

// ---------- read helpers ----------

test('findIdByEmail returns null when no user has that email', async () => {
  expect(await findIdByEmail('ghost@test.oceanview.local')).toBeNull()
})

test('findIdByEmail returns the id when a user with that email exists', async () => {
  const aliceId = await insertMember('alice@test.oceanview.local', 'Alice')
  expect(await findIdByEmail('alice@test.oceanview.local')).toBe(aliceId)
})

test('findAvatarByEmail returns the avatar for a user with an image', async () => {
  await db.insert(user).values({
    name: 'Alice',
    email: 'alice@test.oceanview.local',
    image: 'https://example.com/avatar.webp',
    imageBlurhash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH',
  })
  expect(await findAvatarByEmail('alice@test.oceanview.local')).toEqual({
    name: 'Alice',
    image: 'https://example.com/avatar.webp',
    imageBlurhash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH',
  })
})

test('findAvatarByEmail returns all-null for an unknown email', async () => {
  expect(await findAvatarByEmail('ghost@test.oceanview.local')).toEqual({
    name: null,
    image: null,
    imageBlurhash: null,
  })
})

test('findAvatarByEmail returns all-null for a soft-deleted user', async () => {
  await db.insert(user).values({
    name: 'Old',
    email: 'old@test.oceanview.local',
    image: 'https://example.com/avatar.webp',
    deletedAt: new Date('2020-01-01'),
  })
  expect(await findAvatarByEmail('old@test.oceanview.local')).toEqual({
    name: null,
    image: null,
    imageBlurhash: null,
  })
})

test('listAll returns active users ordered by name', async () => {
  await db.insert(user).values([
    { name: 'Bob', email: 'bob@test.oceanview.local', role: 'user' },
    { name: 'Alice', email: 'alice@test.oceanview.local', role: 'admin' },
  ])
  expect((await listAll()).map((r) => r.name)).toEqual(['Alice', 'Bob'])
})

test('listAll excludes soft-deleted users', async () => {
  const [{ id: aliceId }] = await db
    .insert(user)
    .values([
      { name: 'Alice', email: 'alice@test.oceanview.local' },
      {
        name: 'Old Member',
        email: 'old@test.oceanview.local',
        deletedAt: new Date('2020-01-01'),
      },
    ])
    .returning({ id: user.id })
  expect((await listAll()).map((r) => r.id)).toEqual([aliceId])
})

test('listDeleted returns only soft-deleted users, newest first', async () => {
  const [, { id: olderId }, { id: newerId }] = await db
    .insert(user)
    .values([
      { name: 'Alice', email: 'alice@test.oceanview.local' },
      {
        name: 'Older',
        email: 'older@test.oceanview.local',
        deletedAt: new Date('2020-01-01'),
      },
      {
        name: 'Newer',
        email: 'newer@test.oceanview.local',
        deletedAt: new Date('2025-06-01'),
      },
    ])
    .returning({ id: user.id })
  expect((await listDeleted()).map((r) => r.id)).toEqual([newerId, olderId])
})

test('findRowById returns soft-deleted users for restore flows', async () => {
  const [{ id: oldId }] = await db
    .insert(user)
    .values({
      name: 'Old',
      email: 'old@test.oceanview.local',
      deletedAt: new Date('2020-01-01'),
    })
    .returning({ id: user.id })

  const row = await findRowById(oldId)
  expect(row?.id).toBe(oldId)
  expect(row?.deletedAt).not.toBeNull()
})

test('findRowById returns null for an unknown id', async () => {
  expect(await findRowById(randomUUID())).toBeNull()
})

test('findActiveById hides soft-deleted users', async () => {
  const [{ id: oldId }] = await db
    .insert(user)
    .values({
      name: 'Old',
      email: 'old@test.oceanview.local',
      deletedAt: new Date('2020-01-01'),
    })
    .returning({ id: user.id })

  expect(await findActiveById(oldId)).toBeNull()
})

test('findActiveById returns active users', async () => {
  const aliceId = await insertMember('alice@test.oceanview.local', 'Alice')
  const row = await findActiveById(aliceId)
  expect(row?.id).toBe(aliceId)
})

test('countAdmins counts only active admins', async () => {
  await db.insert(user).values([
    { name: 'A1', email: 'a1@test.oceanview.local', role: 'admin' },
    { name: 'A2', email: 'a2@test.oceanview.local', role: 'admin' },
    {
      name: 'A3',
      email: 'a3@test.oceanview.local',
      role: 'admin',
      deletedAt: new Date(),
    },
    { name: 'U1', email: 'u1@test.oceanview.local', role: 'user' },
  ])
  expect(await countAdmins()).toBe(2)
})

// ---------- inviteUser ----------

test('inviteUser creates a pending user from an email alone', async () => {
  const created = await inviteUser('newbie@test.oceanview.local')
  expect(created).toMatchObject({
    name: 'newbie@test.oceanview.local',
    email: 'newbie@test.oceanview.local',
    phone: '',
    role: 'user',
    emailVerified: false,
    deletedAt: null,
  })
  expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  expect(created.lastInvitedAt).toBeInstanceOf(Date)
})

test('inviteUser throws EMAIL_TAKEN when a user with that email exists', async () => {
  await insertMember('taken@test.oceanview.local', 'Taken')
  await expect(inviteUser('taken@test.oceanview.local')).rejects.toMatchObject({
    code: 'EMAIL_TAKEN',
  })
})

test('inviteUser throws EMAIL_TAKEN even for a soft-deleted email', async () => {
  await db
    .insert(user)
    .values({ name: 'Gone', email: 'gone@test.oceanview.local', deletedAt: new Date() })
  await expect(inviteUser('gone@test.oceanview.local')).rejects.toMatchObject({
    code: 'EMAIL_TAKEN',
  })
})

// ---------- markInvited ----------

test('markInvited refreshes lastInvitedAt', async () => {
  const created = await inviteUser('resend@test.oceanview.local')
  await db
    .update(user)
    .set({ lastInvitedAt: new Date('2020-01-01') })
    .where(eq(user.id, created.id))

  await markInvited(created.id)

  const row = await findActiveById(created.id)
  expect(row?.lastInvitedAt?.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime())
})

// ---------- assertInviteResendable ----------

test('assertInviteResendable returns the row for a pending user', async () => {
  const created = await inviteUser('pending@test.oceanview.local')
  const row = await assertInviteResendable(created.id)
  expect(row.id).toBe(created.id)
})

test('assertInviteResendable throws NOT_FOUND for an unknown id', async () => {
  await expect(assertInviteResendable(randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

test('assertInviteResendable throws NOT_FOUND for a soft-deleted user', async () => {
  const [{ id }] = await db
    .insert(user)
    .values({ name: 'Gone', email: 'gone@test.oceanview.local', deletedAt: new Date() })
    .returning({ id: user.id })
  await expect(assertInviteResendable(id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

test('assertInviteResendable throws ALREADY_ACCEPTED for a verified user', async () => {
  const [{ id }] = await db
    .insert(user)
    .values({ name: 'Active', email: 'active@test.oceanview.local', emailVerified: true })
    .returning({ id: user.id })
  await expect(assertInviteResendable(id)).rejects.toMatchObject({ code: 'ALREADY_ACCEPTED' })
})

// ---------- updateAsAdmin ----------

test('updateAsAdmin patches the target and returns the updated row', async () => {
  const adminId = await insertAdmin('admin@test.oceanview.local', 'Admin')
  const aliceId = await insertMember('alice@test.oceanview.local', 'Alice')

  const updated = await updateAsAdmin(adminId, aliceId, {
    name: 'Alice Updated',
    phone: '111',
    role: 'admin',
  })

  expect(updated.name).toBe('Alice Updated')
  expect(updated.role).toBe('admin')
  expect(updated.phone).toBe('111')
})

test('updateAsAdmin leaves the target email unchanged (email is immutable)', async () => {
  const adminId = await insertAdmin('admin@test.oceanview.local', 'Admin')
  const aliceId = await insertMember('alice@test.oceanview.local', 'Alice')

  const updated = await updateAsAdmin(adminId, aliceId, {
    name: 'Alice Updated',
    phone: '111',
    role: 'user',
  })

  // Email is the magic-link login identity (ADR-0017) — not part of the input,
  // so the row keeps its original address regardless of what an admin edits.
  expect(updated.email).toBe('alice@test.oceanview.local')
})

test('updateAsAdmin throws NOT_FOUND when target does not exist', async () => {
  const adminId = await insertAdmin('admin@test.oceanview.local', 'Admin')
  await expect(
    updateAsAdmin(adminId, randomUUID(), { ...standardInput, role: 'admin' }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

test('updateAsAdmin throws TARGET_DELETED when target is soft-deleted', async () => {
  const adminId = await insertAdmin('admin@test.oceanview.local', 'Admin')
  const [{ id: deletedId }] = await db
    .insert(user)
    .values({
      name: 'Deleted',
      email: 'deleted@test.oceanview.local',
      deletedAt: new Date(),
    })
    .returning({ id: user.id })

  await expect(
    updateAsAdmin(adminId, deletedId, { ...standardInput, role: 'user' }),
  ).rejects.toMatchObject({ code: 'TARGET_DELETED' })
})

test('updateAsAdmin throws CANNOT_ACT_ON_SELF when admin demotes themselves', async () => {
  const adminId = await insertAdmin('admin@test.oceanview.local', 'Admin')
  // Second admin so the LAST_ADMIN guard wouldn't trip first.
  await insertAdmin('admin2@test.oceanview.local', 'Admin2')

  await expect(
    updateAsAdmin(adminId, adminId, {
      name: 'Admin',
      phone: '111',
      role: 'user',
    }),
  ).rejects.toMatchObject({ code: 'CANNOT_ACT_ON_SELF' })
})

test('updateAsAdmin lets an admin update their own non-role fields', async () => {
  const adminId = await insertAdmin('admin@test.oceanview.local', 'Admin')

  const updated = await updateAsAdmin(adminId, adminId, {
    name: 'Admin Renamed',
    phone: '999',
    role: 'admin',
  })

  expect(updated.name).toBe('Admin Renamed')
  expect(updated.phone).toBe('999')
})

test('updateAsAdmin throws LAST_ADMIN when demoting the only admin', async () => {
  const adminId = await insertAdmin('admin@test.oceanview.local', 'Admin')
  const otherAdminId = await insertAdmin('admin2@test.oceanview.local', 'Admin2')

  // Demote the second admin directly so only one remains; guard should now block.
  await db.update(user).set({ role: 'user' }).where(eq(user.id, otherAdminId))

  await expect(
    updateAsAdmin(otherAdminId, adminId, {
      name: 'Admin',
      phone: '111',
      role: 'user',
    }),
  ).rejects.toMatchObject({ code: 'LAST_ADMIN' })
})

// ---------- updateOwnProfile ----------

test('updateOwnProfile patches name and phone on the caller own row', async () => {
  const aliceId = await insertMember('alice@test.oceanview.local', 'alice@test.oceanview.local')

  const updated = await updateOwnProfile(aliceId, { name: 'Alice Svensson', phone: '070-1' })

  expect(updated.name).toBe('Alice Svensson')
  expect(updated.phone).toBe('070-1')
})

test('updateOwnProfile patches only the provided field', async () => {
  const aliceId = await insertMember('alice@test.oceanview.local', 'Alice')
  await updateOwnProfile(aliceId, { phone: '070-2' })

  const updated = await updateOwnProfile(aliceId, { name: 'Renamed' })

  // name changed in the second call; phone from the first call is untouched.
  expect(updated.name).toBe('Renamed')
  expect(updated.phone).toBe('070-2')
})

test('updateOwnProfile throws NOT_FOUND for an unknown id', async () => {
  await expect(updateOwnProfile(randomUUID(), { name: 'X' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  })
})

test('updateOwnProfile throws TARGET_DELETED for a soft-deleted user', async () => {
  const [{ id: deletedId }] = await db
    .insert(user)
    .values({ name: 'Gone', email: 'gone@test.oceanview.local', deletedAt: new Date() })
    .returning({ id: user.id })

  await expect(updateOwnProfile(deletedId, { name: 'X' })).rejects.toMatchObject({
    code: 'TARGET_DELETED',
  })
})

// ---------- completeOnboarding ----------

test('completeOnboarding stamps onboardedAt on a fresh invitee', async () => {
  const created = await inviteUser('newbie@test.oceanview.local')
  expect(created.onboardedAt).toBeNull()

  const updated = await completeOnboarding(created.id)

  expect(updated.onboardedAt).toBeInstanceOf(Date)
})

test('completeOnboarding is idempotent (rewrites the timestamp)', async () => {
  const created = await inviteUser('newbie@test.oceanview.local')
  const first = await completeOnboarding(created.id)
  const second = await completeOnboarding(created.id)

  expect(first.onboardedAt).toBeInstanceOf(Date)
  expect(second.onboardedAt).toBeInstanceOf(Date)
})

test('completeOnboarding throws NOT_FOUND for an unknown id', async () => {
  await expect(completeOnboarding(randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

test('completeOnboarding throws TARGET_DELETED for a soft-deleted user', async () => {
  const [{ id: deletedId }] = await db
    .insert(user)
    .values({ name: 'Gone', email: 'gone@test.oceanview.local', deletedAt: new Date() })
    .returning({ id: user.id })

  await expect(completeOnboarding(deletedId)).rejects.toMatchObject({ code: 'TARGET_DELETED' })
})

// ---------- softDeleteAsAdmin ----------

test('softDeleteAsAdmin sets deletedAt', async () => {
  const adminId = await insertAdmin('admin@test.oceanview.local', 'Admin')
  const aliceId = await insertMember('alice@test.oceanview.local', 'Alice')

  await softDeleteAsAdmin(adminId, aliceId)

  const [row] = await db
    .select({ deletedAt: user.deletedAt })
    .from(user)
    .where(eq(user.id, aliceId))
  expect(row?.deletedAt).toBeInstanceOf(Date)
})

test('softDeleteAsAdmin is idempotent on already-deleted users', async () => {
  const adminId = await insertAdmin('admin@test.oceanview.local', 'Admin')
  const [{ id: oldId }] = await db
    .insert(user)
    .values({
      name: 'Old',
      email: 'old@test.oceanview.local',
      deletedAt: new Date('2020-01-01'),
    })
    .returning({ id: user.id })

  await expect(softDeleteAsAdmin(adminId, oldId)).resolves.toBeUndefined()
})

test('softDeleteAsAdmin throws NOT_FOUND for unknown id', async () => {
  const adminId = await insertAdmin('admin@test.oceanview.local', 'Admin')
  await expect(softDeleteAsAdmin(adminId, randomUUID())).rejects.toMatchObject({
    code: 'NOT_FOUND',
  })
})

test('softDeleteAsAdmin throws CANNOT_ACT_ON_SELF when admin deletes themselves', async () => {
  const adminId = await insertAdmin('admin@test.oceanview.local', 'Admin')
  await expect(softDeleteAsAdmin(adminId, adminId)).rejects.toMatchObject({
    code: 'CANNOT_ACT_ON_SELF',
  })
})

test('softDeleteAsAdmin throws LAST_ADMIN when deleting the only admin', async () => {
  const soloAdminId = await insertAdmin('admin@test.oceanview.local', 'Admin')
  const otherAdminId = await insertAdmin('admin2@test.oceanview.local', 'Admin2')

  // Drop second admin to user so only `soloAdminId` remains.
  await db.update(user).set({ role: 'user' }).where(eq(user.id, otherAdminId))

  await expect(softDeleteAsAdmin(otherAdminId, soloAdminId)).rejects.toMatchObject({
    code: 'LAST_ADMIN',
  })
})

test('softDeleteAsAdmin allows deleting a non-admin even with only one admin', async () => {
  const adminId = await insertAdmin('admin@test.oceanview.local', 'Admin')
  const aliceId = await insertMember('alice@test.oceanview.local', 'Alice')
  await expect(softDeleteAsAdmin(adminId, aliceId)).resolves.toBeUndefined()
})

// ---------- restoreAsAdmin ----------

test('restoreAsAdmin clears deletedAt', async () => {
  const [{ id: oldId }] = await db
    .insert(user)
    .values({
      name: 'Old',
      email: 'old@test.oceanview.local',
      deletedAt: new Date('2020-01-01'),
    })
    .returning({ id: user.id })

  await restoreAsAdmin(oldId)

  const [row] = await db.select({ deletedAt: user.deletedAt }).from(user).where(eq(user.id, oldId))
  expect(row?.deletedAt).toBeNull()
})

test('restoreAsAdmin is idempotent on active users', async () => {
  const aliceId = await insertMember('alice@test.oceanview.local', 'Alice')
  await expect(restoreAsAdmin(aliceId)).resolves.toBeUndefined()
})

test('restoreAsAdmin throws NOT_FOUND for unknown id', async () => {
  await expect(restoreAsAdmin(randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

// ---------- setImage (worker avatar repoint) ----------

test('setImage repoints user.image and returns true', async () => {
  const id = await insertMember('avatar@test.oceanview.local', 'Avatar User')
  const ok = await setImage(id, 'https://blob.example/avatars/x.jpg')
  expect(ok).toBe(true)
  const [row] = await db.select({ image: user.image }).from(user).where(eq(user.id, id))
  expect(row.image).toBe('https://blob.example/avatars/x.jpg')
})

test('setImage returns false when the user is gone', async () => {
  expect(await setImage(randomUUID(), 'https://blob.example/x.jpg')).toBe(false)
})

// ---------- error shape ----------

test('UserDomainError instances carry the discriminating code field', async () => {
  const adminId = await insertAdmin('admin@test.oceanview.local', 'Admin')
  try {
    await softDeleteAsAdmin(adminId, adminId)
    throw new Error('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(UserDomainError)
    expect((err as UserDomainError).code).toBe('CANNOT_ACT_ON_SELF')
  }
})
