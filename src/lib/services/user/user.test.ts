import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { approvedEmail, user } from '~/lib/db/schema'
import { isApproved, listApproved } from '~/lib/services/approvedEmail'
import { setupDatabase } from '~test/setup'
import { UserDomainError } from './errors'
import {
  assertPendingInvite,
  completeOnboarding,
  countAdmins,
  findActiveById,
  findAvatarByEmail,
  findRowById,
  inviteUser,
  listAll,
  listUsersAndPending,
  revokeUser,
  setImage,
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

test('findAvatarByEmail returns the avatar for a user with an image', async () => {
  await db.insert(user).values({
    name: 'Alice',
    email: 'alice@test.videbacken.local',
    image: 'https://example.com/avatar.webp',
    imageBlurhash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH',
  })
  expect(await findAvatarByEmail('alice@test.videbacken.local')).toEqual({
    name: 'Alice',
    image: 'https://example.com/avatar.webp',
    imageBlurhash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH',
  })
})

test('findAvatarByEmail returns all-null for an unknown email', async () => {
  expect(await findAvatarByEmail('ghost@test.videbacken.local')).toEqual({
    name: null,
    image: null,
    imageBlurhash: null,
  })
})

test('findAvatarByEmail returns all-null for a soft-deleted user', async () => {
  await db.insert(user).values({
    name: 'Old',
    email: 'old@test.videbacken.local',
    image: 'https://example.com/avatar.webp',
    deletedAt: new Date('2020-01-01'),
  })
  expect(await findAvatarByEmail('old@test.videbacken.local')).toEqual({
    name: null,
    image: null,
    imageBlurhash: null,
  })
})

test('listAll returns active users ordered by name', async () => {
  await db.insert(user).values([
    { name: 'Bob', email: 'bob@test.videbacken.local', role: 'user' },
    { name: 'Alice', email: 'alice@test.videbacken.local', role: 'admin' },
  ])
  expect((await listAll()).map((r) => r.name)).toEqual(['Alice', 'Bob'])
})

test('listAll excludes soft-deleted users', async () => {
  const [{ id: aliceId }] = await db
    .insert(user)
    .values([
      { name: 'Alice', email: 'alice@test.videbacken.local' },
      {
        name: 'Old Member',
        email: 'old@test.videbacken.local',
        deletedAt: new Date('2020-01-01'),
      },
    ])
    .returning({ id: user.id })
  expect((await listAll()).map((r) => r.id)).toEqual([aliceId])
})

test('findRowById returns soft-deleted users for internal lookups', async () => {
  const [{ id: oldId }] = await db
    .insert(user)
    .values({
      name: 'Old',
      email: 'old@test.videbacken.local',
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
      email: 'old@test.videbacken.local',
      deletedAt: new Date('2020-01-01'),
    })
    .returning({ id: user.id })

  expect(await findActiveById(oldId)).toBeNull()
})

test('findActiveById returns active users', async () => {
  const aliceId = await insertMember('alice@test.videbacken.local', 'Alice')
  const row = await findActiveById(aliceId)
  expect(row?.id).toBe(aliceId)
})

test('countAdmins counts only active admins', async () => {
  await db.insert(user).values([
    { name: 'A1', email: 'a1@test.videbacken.local', role: 'admin' },
    { name: 'A2', email: 'a2@test.videbacken.local', role: 'admin' },
    {
      name: 'A3',
      email: 'a3@test.videbacken.local',
      role: 'admin',
      deletedAt: new Date(),
    },
    { name: 'U1', email: 'u1@test.videbacken.local', role: 'user' },
  ])
  expect(await countAdmins()).toBe(2)
})

// ---------- inviteUser ----------
// Invite = add the email to the approved_email allowlist. No `user` row is
// created — first sign-in (Google or magic-link) is what creates it, stamped
// with the role recorded here (see ADR-0017 amendment).

test('inviteUser adds the email to the allowlist with the given role', async () => {
  const adminId = await insertAdmin('admin@test.videbacken.local', 'Admin')

  const created = await inviteUser({
    email: 'newbie@test.videbacken.local',
    role: 'user',
    actorUserId: adminId,
  })

  expect(created.email).toBe('newbie@test.videbacken.local')
  expect(created.role).toBe('user')
  expect(created.addedByUserId).toBe(adminId)
  expect(await isApproved('newbie@test.videbacken.local')).toEqual({ role: 'user' })
})

test('inviteUser creates no user row', async () => {
  const adminId = await insertAdmin('admin@test.videbacken.local', 'Admin')

  await inviteUser({ email: 'newbie2@test.videbacken.local', role: 'user', actorUserId: adminId })

  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, 'newbie2@test.videbacken.local'))
  expect(row).toBeUndefined()
})

test('inviteUser normalizes the email (case-insensitive)', async () => {
  const adminId = await insertAdmin('admin@test.videbacken.local', 'Admin')

  await inviteUser({ email: 'Mixed@Test.Videbacken.Local', role: 'admin', actorUserId: adminId })

  expect(await isApproved('mixed@test.videbacken.local')).toEqual({ role: 'admin' })
})

test('inviteUser throws EMAIL_ALREADY_APPROVED for a still-pending invite', async () => {
  const adminId = await insertAdmin('admin@test.videbacken.local', 'Admin')
  await inviteUser({ email: 'pending@test.videbacken.local', role: 'user', actorUserId: adminId })

  await expect(
    inviteUser({ email: 'pending@test.videbacken.local', role: 'admin', actorUserId: adminId }),
  ).rejects.toMatchObject({ code: 'EMAIL_ALREADY_APPROVED' })
})

test('inviteUser throws EMAIL_ALREADY_APPROVED for an already-active user', async () => {
  const adminId = await insertAdmin('admin@test.videbacken.local', 'Admin')
  await db.insert(approvedEmail).values({ email: 'active@test.videbacken.local', role: 'user' })
  await insertMember('active@test.videbacken.local', 'Active')

  await expect(
    inviteUser({ email: 'active@test.videbacken.local', role: 'user', actorUserId: adminId }),
  ).rejects.toMatchObject({ code: 'EMAIL_ALREADY_APPROVED' })
})

// ---------- assertPendingInvite ----------

test('assertPendingInvite returns the email + role for a pending invite', async () => {
  const adminId = await insertAdmin('admin@test.videbacken.local', 'Admin')
  await inviteUser({ email: 'pending@test.videbacken.local', role: 'admin', actorUserId: adminId })

  expect(await assertPendingInvite('pending@test.videbacken.local')).toEqual({
    email: 'pending@test.videbacken.local',
    role: 'admin',
  })
})

test('assertPendingInvite throws NOT_FOUND for an email never invited', async () => {
  await expect(assertPendingInvite('ghost@test.videbacken.local')).rejects.toMatchObject({
    code: 'NOT_FOUND',
  })
})

test('assertPendingInvite throws ALREADY_ACCEPTED once the invitee has an active user row', async () => {
  await db.insert(approvedEmail).values({ email: 'active@test.videbacken.local', role: 'user' })
  await insertMember('active@test.videbacken.local', 'Active')

  await expect(assertPendingInvite('active@test.videbacken.local')).rejects.toMatchObject({
    code: 'ALREADY_ACCEPTED',
  })
})

// ---------- revokeUser ----------

test('revokeUser removes a pending invite from the allowlist', async () => {
  const adminId = await insertAdmin('admin@test.videbacken.local', 'Admin')
  await inviteUser({ email: 'pending@test.videbacken.local', role: 'user', actorUserId: adminId })

  const result = await revokeUser({ email: 'pending@test.videbacken.local', actorUserId: adminId })

  expect(result).toEqual({ userId: null })
  expect(await isApproved('pending@test.videbacken.local')).toBeNull()
})

test('revokeUser soft-deletes the matching active user and removes the allowlist row', async () => {
  const adminId = await insertAdmin('admin@test.videbacken.local', 'Admin')
  await db.insert(approvedEmail).values({ email: 'alice@test.videbacken.local', role: 'user' })
  const aliceId = await insertMember('alice@test.videbacken.local', 'Alice')

  const result = await revokeUser({ email: 'alice@test.videbacken.local', actorUserId: adminId })

  expect(result).toEqual({ userId: aliceId })
  const [row] = await db.select({ deletedAt: user.deletedAt }).from(user).where(eq(user.id, aliceId))
  expect(row?.deletedAt).toBeInstanceOf(Date)
  expect(await isApproved('alice@test.videbacken.local')).toBeNull()
})

test('revokeUser throws NOT_FOUND for an email that was never approved', async () => {
  const adminId = await insertAdmin('admin@test.videbacken.local', 'Admin')
  await expect(
    revokeUser({ email: 'ghost@test.videbacken.local', actorUserId: adminId }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

test('revokeUser throws CANNOT_ACT_ON_SELF when an admin revokes their own access', async () => {
  const adminId = await insertAdmin('admin@test.videbacken.local', 'Admin')
  await db.insert(approvedEmail).values({ email: 'admin@test.videbacken.local', role: 'admin' })

  await expect(
    revokeUser({ email: 'admin@test.videbacken.local', actorUserId: adminId }),
  ).rejects.toMatchObject({ code: 'CANNOT_ACT_ON_SELF' })
})

test('revokeUser throws LAST_ADMIN when revoking the sole remaining admin', async () => {
  await insertAdmin('admin@test.videbacken.local', 'Admin')
  await db.insert(approvedEmail).values({ email: 'admin@test.videbacken.local', role: 'admin' })
  const otherAdminId = await insertAdmin('admin2@test.videbacken.local', 'Admin2')

  // Drop the second admin to user so only `admin@test.videbacken.local` remains one.
  await db.update(user).set({ role: 'user' }).where(eq(user.id, otherAdminId))

  await expect(
    revokeUser({ email: 'admin@test.videbacken.local', actorUserId: otherAdminId }),
  ).rejects.toMatchObject({ code: 'LAST_ADMIN' })
})

test('revokeUser is idempotent on an already soft-deleted user (does not re-stamp deletedAt, still clears the allowlist)', async () => {
  const adminId = await insertAdmin('admin@test.videbacken.local', 'Admin')
  await db.insert(approvedEmail).values({ email: 'old@test.videbacken.local', role: 'user' })
  const originalDeletedAt = new Date('2020-01-01')
  const [{ id: oldId }] = await db
    .insert(user)
    .values({ name: 'Old', email: 'old@test.videbacken.local', deletedAt: originalDeletedAt })
    .returning({ id: user.id })

  // Still reports the user id (harmless to re-revoke already-gone sessions),
  // but must not touch the original deletedAt stamp.
  await expect(
    revokeUser({ email: 'old@test.videbacken.local', actorUserId: adminId }),
  ).resolves.toEqual({ userId: oldId })
  expect(await isApproved('old@test.videbacken.local')).toBeNull()
  const [row] = await db.select({ deletedAt: user.deletedAt }).from(user).where(eq(user.id, oldId))
  expect(row?.deletedAt).toEqual(originalDeletedAt)
})

// ---------- listUsersAndPending ----------

test('listUsersAndPending returns active users tagged status "active"', async () => {
  const aliceId = await insertMember('alice@test.videbacken.local', 'Alice')

  const rows = await listUsersAndPending()

  expect(rows).toEqual([
    expect.objectContaining({ status: 'active', id: aliceId, email: 'alice@test.videbacken.local' }),
  ])
})

test('listUsersAndPending includes approved emails with no matching user, tagged "pending"', async () => {
  const adminId = await insertAdmin('admin@test.videbacken.local', 'Admin')
  await inviteUser({ email: 'invitee@test.videbacken.local', role: 'admin', actorUserId: adminId })

  const rows = await listUsersAndPending()
  const pending = rows.find((r) => r.email === 'invitee@test.videbacken.local')

  expect(pending).toMatchObject({
    status: 'pending',
    email: 'invitee@test.videbacken.local',
    role: 'admin',
    name: null,
    phone: null,
  })
})

test('listUsersAndPending excludes an approved email once it has an active user', async () => {
  await db.insert(approvedEmail).values({ email: 'alice@test.videbacken.local', role: 'user' })
  const aliceId = await insertMember('alice@test.videbacken.local', 'Alice')

  const rows = await listUsersAndPending()

  expect(rows).toEqual([expect.objectContaining({ status: 'active', id: aliceId })])
})

test('listUsersAndPending excludes soft-deleted users entirely', async () => {
  await db.insert(user).values({
    name: 'Old',
    email: 'old@test.videbacken.local',
    deletedAt: new Date('2020-01-01'),
  })

  expect(await listUsersAndPending()).toEqual([])
})

// ---------- updateAsAdmin ----------

test('updateAsAdmin patches the target and returns the updated row', async () => {
  const adminId = await insertAdmin('admin@test.videbacken.local', 'Admin')
  const aliceId = await insertMember('alice@test.videbacken.local', 'Alice')

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
  const adminId = await insertAdmin('admin@test.videbacken.local', 'Admin')
  const aliceId = await insertMember('alice@test.videbacken.local', 'Alice')

  const updated = await updateAsAdmin(adminId, aliceId, {
    name: 'Alice Updated',
    phone: '111',
    role: 'user',
  })

  // Email is the sign-in identity — not part of the input, so the row keeps
  // its original address regardless of what an admin edits.
  expect(updated.email).toBe('alice@test.videbacken.local')
})

test('updateAsAdmin throws NOT_FOUND when target does not exist', async () => {
  const adminId = await insertAdmin('admin@test.videbacken.local', 'Admin')
  await expect(
    updateAsAdmin(adminId, randomUUID(), { ...standardInput, role: 'admin' }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

test('updateAsAdmin throws TARGET_DELETED when target is soft-deleted', async () => {
  const adminId = await insertAdmin('admin@test.videbacken.local', 'Admin')
  const [{ id: deletedId }] = await db
    .insert(user)
    .values({
      name: 'Deleted',
      email: 'deleted@test.videbacken.local',
      deletedAt: new Date(),
    })
    .returning({ id: user.id })

  await expect(
    updateAsAdmin(adminId, deletedId, { ...standardInput, role: 'user' }),
  ).rejects.toMatchObject({ code: 'TARGET_DELETED' })
})

test('updateAsAdmin throws CANNOT_ACT_ON_SELF when admin demotes themselves', async () => {
  const adminId = await insertAdmin('admin@test.videbacken.local', 'Admin')
  // Second admin so the LAST_ADMIN guard wouldn't trip first.
  await insertAdmin('admin2@test.videbacken.local', 'Admin2')

  await expect(
    updateAsAdmin(adminId, adminId, {
      name: 'Admin',
      phone: '111',
      role: 'user',
    }),
  ).rejects.toMatchObject({ code: 'CANNOT_ACT_ON_SELF' })
})

test('updateAsAdmin lets an admin update their own non-role fields', async () => {
  const adminId = await insertAdmin('admin@test.videbacken.local', 'Admin')

  const updated = await updateAsAdmin(adminId, adminId, {
    name: 'Admin Renamed',
    phone: '999',
    role: 'admin',
  })

  expect(updated.name).toBe('Admin Renamed')
  expect(updated.phone).toBe('999')
})

test('updateAsAdmin throws LAST_ADMIN when demoting the only admin', async () => {
  const adminId = await insertAdmin('admin@test.videbacken.local', 'Admin')
  const otherAdminId = await insertAdmin('admin2@test.videbacken.local', 'Admin2')

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
  const aliceId = await insertMember('alice@test.videbacken.local', 'alice@test.videbacken.local')

  const updated = await updateOwnProfile(aliceId, { name: 'Alice Svensson', phone: '070-1' })

  expect(updated.name).toBe('Alice Svensson')
  expect(updated.phone).toBe('070-1')
})

test('updateOwnProfile patches only the provided field', async () => {
  const aliceId = await insertMember('alice@test.videbacken.local', 'Alice')
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
    .values({ name: 'Gone', email: 'gone@test.videbacken.local', deletedAt: new Date() })
    .returning({ id: user.id })

  await expect(updateOwnProfile(deletedId, { name: 'X' })).rejects.toMatchObject({
    code: 'TARGET_DELETED',
  })
})

// ---------- completeOnboarding ----------

test('completeOnboarding stamps onboardedAt on a fresh user', async () => {
  const aliceId = await insertMember('alice@test.videbacken.local', 'Alice')

  const updated = await completeOnboarding(aliceId)

  expect(updated.onboardedAt).toBeInstanceOf(Date)
})

test('completeOnboarding is idempotent (rewrites the timestamp)', async () => {
  const aliceId = await insertMember('alice@test.videbacken.local', 'Alice')
  const first = await completeOnboarding(aliceId)
  const second = await completeOnboarding(aliceId)

  expect(first.onboardedAt).toBeInstanceOf(Date)
  expect(second.onboardedAt).toBeInstanceOf(Date)
})

test('completeOnboarding throws NOT_FOUND for an unknown id', async () => {
  await expect(completeOnboarding(randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

test('completeOnboarding throws TARGET_DELETED for a soft-deleted user', async () => {
  const [{ id: deletedId }] = await db
    .insert(user)
    .values({ name: 'Gone', email: 'gone@test.videbacken.local', deletedAt: new Date() })
    .returning({ id: user.id })

  await expect(completeOnboarding(deletedId)).rejects.toMatchObject({ code: 'TARGET_DELETED' })
})

// ---------- setImage (worker avatar repoint) ----------

test('setImage repoints user.image and returns true', async () => {
  const id = await insertMember('avatar@test.videbacken.local', 'Avatar User')
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
  const adminId = await insertAdmin('admin@test.videbacken.local', 'Admin')
  await db.insert(approvedEmail).values({ email: 'admin@test.videbacken.local', role: 'admin' })
  try {
    await revokeUser({ email: 'admin@test.videbacken.local', actorUserId: adminId })
    throw new Error('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(UserDomainError)
    expect((err as UserDomainError).code).toBe('CANNOT_ACT_ON_SELF')
  }
})

test('listApproved sees rows added via inviteUser (cross-service sanity check)', async () => {
  const adminId = await insertAdmin('admin@test.videbacken.local', 'Admin')
  await inviteUser({ email: 'cross@test.videbacken.local', role: 'user', actorUserId: adminId })

  expect((await listApproved()).map((r) => r.email)).toContain('cross@test.videbacken.local')
})
