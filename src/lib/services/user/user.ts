import { and, asc, count, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import { normalizeEmail } from '~/lib/adminAllowlist'
import { db } from '~/lib/db'
import { user } from '~/lib/db/schema'
import { UserDomainError } from './errors'

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type DbOrTx = typeof db | DbTransaction

/**
 * How long an invitation's sign-in link stays valid. Drives both Better Auth's
 * email-verification token TTL (`emailVerification.expiresIn` in auth.ts) and
 * the client-side "Inbjuden — går ut om …" countdown (`inviteExpiresAt` is
 * derived as `lastInvitedAt + INVITE_EXPIRY_SECONDS`). One source of truth for
 * the duration, so the displayed expiry tracks the token's real lifetime up to
 * the sub-second gap between stamping `lastInvitedAt` and Better Auth minting
 * the token.
 */
export const INVITE_EXPIRY_SECONDS = 60 * 60 * 24 * 7 // 7 days

export type UserRow = {
  id: string
  name: string
  email: string
  phone: string | null
  role: string | null
  image: string | null
  imageBlurhash: string | null
  createdAt: Date
  deletedAt: Date | null
  // `false` until the user completes their first sign-in (invite link or
  // magic-link) — this is what "Inbjuden" / pending is derived from.
  emailVerified: boolean
  // When the latest invite email was sent; null for self-signed-up users.
  lastInvitedAt: Date | null
  // When the user finished (or skipped through) the onboarding wizard; null
  // until then. The _authenticated loader routes null-onboardedAt users to
  // /onboarding. See ADR-0017.
  onboardedAt: Date | null
}

// Email is intentionally absent: it is the magic-link login identity, so it is
// immutable after invite (an admin typo would silently lock the user out — see
// ADR-0017). To change an address, delete + re-invite.
export type UpdateUserInput = {
  name: string
  phone: string
  role: 'user' | 'admin'
}

// Self-service profile edit (onboarding wizard). Both optional so a single step
// can patch just its one field. Role and email are deliberately absent — a user
// can never change their own role, and email is the immutable login identity.
export type UpdateOwnProfileInput = {
  name?: string
  phone?: string
}

const userSelection = {
  id: user.id,
  name: user.name,
  email: user.email,
  phone: user.phone,
  role: user.role,
  image: user.image,
  imageBlurhash: user.imageBlurhash,
  createdAt: user.createdAt,
  deletedAt: user.deletedAt,
  emailVerified: user.emailVerified,
  lastInvitedAt: user.lastInvitedAt,
  onboardedAt: user.onboardedAt,
}

export async function findIdByEmail(email: string): Promise<string | null> {
  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1)
  return row?.id ?? null
}

// Live name + avatar lookup for the "Välkommen tillbaka" login card, called by
// the getBrowserSession server fn with the email from the browser-session cookie
// (never a caller-supplied address). Returns all-null for unknown or
// soft-deleted emails — indistinguishable from an avatar-less account.
export async function findAvatarByEmail(
  email: string,
): Promise<{ name: string | null; image: string | null; imageBlurhash: string | null }> {
  const [row] = await db
    .select({ name: user.name, image: user.image, imageBlurhash: user.imageBlurhash })
    .from(user)
    .where(and(eq(user.email, email), isNull(user.deletedAt)))
    .limit(1)
  return {
    name: row?.name ?? null,
    image: row?.image ?? null,
    imageBlurhash: row?.imageBlurhash ?? null,
  }
}

export async function listAll(): Promise<Array<UserRow>> {
  return db.select(userSelection).from(user).where(isNull(user.deletedAt)).orderBy(asc(user.name))
}

export async function listDeleted(): Promise<Array<UserRow>> {
  return db
    .select(userSelection)
    .from(user)
    .where(isNotNull(user.deletedAt))
    .orderBy(desc(user.deletedAt))
}

export async function findRowById(id: string, dbOrTx: DbOrTx = db): Promise<UserRow | null> {
  const [row] = await dbOrTx.select(userSelection).from(user).where(eq(user.id, id)).limit(1)
  return row ?? null
}

export async function findActiveById(id: string, dbOrTx: DbOrTx = db): Promise<UserRow | null> {
  const row = await findRowById(id, dbOrTx)
  if (!row || row.deletedAt) return null
  return row
}

export async function countAdmins(dbOrTx: DbOrTx = db): Promise<number> {
  const [row] = await dbOrTx
    .select({ value: count() })
    .from(user)
    .where(and(eq(user.role, 'admin'), isNull(user.deletedAt)))
  return Number(row?.value ?? 0)
}

/**
 * Create an invited user from an email alone. Name/phone/avatar are collected
 * later in onboarding, so `name` is seeded to the email (a sensible display
 * fallback everywhere the UI renders `user.name` until then) and `phone` is
 * blank. Every invitee starts as `user`; admins promote afterward. The row is
 * unverified (pending) and stamped `lastInvitedAt` so the list can show the
 * countdown immediately. The actual invite email is sent by the procedure via
 * Better Auth's `sendVerificationEmail` (tier-3 queue).
 */
export async function inviteUser(email: string): Promise<UserRow> {
  // Normalize here so the op is self-guarding regardless of caller: the
  // EMAIL_TAKEN check and the stored row use the same lowercased form Better Auth
  // stores, so a case-variant ("Foo@x") can't slip past the check and collide
  // only at the case-sensitive unique index.
  const normalized = normalizeEmail(email)
  // Check-first (ADR-0002): the unique constraint is the backstop, but a clear
  // domain error beats a raw 23505 — the admin should resend/restore instead.
  if (await findIdByEmail(normalized)) throw new UserDomainError('EMAIL_TAKEN')
  const [row] = await db
    .insert(user)
    .values({
      name: normalized,
      email: normalized,
      phone: '',
      role: 'user',
      emailVerified: false,
      lastInvitedAt: new Date(),
    })
    .returning(userSelection)
  return row
}

/** Bump the invite timestamp when an admin resends, so the countdown resets. */
export async function markInvited(targetId: string): Promise<void> {
  await db.update(user).set({ lastInvitedAt: new Date() }).where(eq(user.id, targetId))
}

/**
 * Guard a resend: the target must exist, be active, and still be pending.
 * `findActiveById` returns null for unknown *and* soft-deleted users (both
 * map to NOT_FOUND); an already-accepted (verified) user can't be re-invited.
 */
export async function assertInviteResendable(targetId: string): Promise<UserRow> {
  const target = await findActiveById(targetId)
  if (!target) throw new UserDomainError('NOT_FOUND')
  if (target.emailVerified) throw new UserDomainError('ALREADY_ACCEPTED')
  return target
}

export async function updateAsAdmin(
  actorId: string,
  targetId: string,
  input: UpdateUserInput,
): Promise<UserRow> {
  return db.transaction(async (tx) => {
    const target = await findRowById(targetId, tx)
    if (!target) throw new UserDomainError('NOT_FOUND')
    if (target.deletedAt) throw new UserDomainError('TARGET_DELETED')

    const demotingSelf = actorId === targetId && input.role !== 'admin'
    if (demotingSelf) throw new UserDomainError('CANNOT_ACT_ON_SELF')

    const demotingAdmin = target.role === 'admin' && input.role !== 'admin'
    if (demotingAdmin && (await countAdmins(tx)) <= 1) {
      throw new UserDomainError('LAST_ADMIN')
    }

    const [row] = await tx
      .update(user)
      .set({
        name: input.name,
        phone: input.phone,
        role: input.role,
      })
      .where(eq(user.id, targetId))
      .returning(userSelection)
    return row
  })
}

/**
 * Self-service profile update used by the onboarding wizard. The procedure
 * scopes `userId` to the caller's own id, so this only ever touches the actor's
 * row. Check-first (ADR-0002): a missing or soft-deleted row is a domain error,
 * not a silent no-op. Only the provided fields are written.
 */
export async function updateOwnProfile(
  userId: string,
  input: UpdateOwnProfileInput,
): Promise<UserRow> {
  return db.transaction(async (tx) => {
    const target = await findRowById(userId, tx)
    if (!target) throw new UserDomainError('NOT_FOUND')
    if (target.deletedAt) throw new UserDomainError('TARGET_DELETED')

    // Nothing to write — skip the no-op UPDATE (an all-undefined `.set` is
    // invalid SQL). Drizzle drops the `undefined` keys for a partial patch.
    if (input.name === undefined && input.phone === undefined) return target

    const [row] = await tx
      .update(user)
      .set(input)
      .where(eq(user.id, userId))
      .returning(userSelection)
    return row
  })
}

/**
 * Stamp the user as onboarded — fired when they finish (or skip through) the
 * wizard's final step. Idempotent: a repeat call just rewrites the timestamp.
 * Null `onboardedAt` is what the _authenticated loader uses to force the wizard,
 * so this is what lets the user reach the rest of the app. See ADR-0017.
 */
export async function completeOnboarding(userId: string): Promise<UserRow> {
  return db.transaction(async (tx) => {
    const target = await findRowById(userId, tx)
    if (!target) throw new UserDomainError('NOT_FOUND')
    if (target.deletedAt) throw new UserDomainError('TARGET_DELETED')

    const [row] = await tx
      .update(user)
      .set({ onboardedAt: new Date() })
      .where(eq(user.id, userId))
      .returning(userSelection)
    return row
  })
}

export async function softDeleteAsAdmin(actorId: string, targetId: string): Promise<void> {
  if (actorId === targetId) throw new UserDomainError('CANNOT_ACT_ON_SELF')

  await db.transaction(async (tx) => {
    const target = await findRowById(targetId, tx)
    if (!target) throw new UserDomainError('NOT_FOUND')
    if (target.deletedAt) return

    if (target.role === 'admin' && (await countAdmins(tx)) <= 1) {
      throw new UserDomainError('LAST_ADMIN')
    }

    await tx.update(user).set({ deletedAt: new Date() }).where(eq(user.id, targetId))
  })
}

export async function restoreAsAdmin(targetId: string): Promise<void> {
  const target = await findRowById(targetId)
  if (!target) throw new UserDomainError('NOT_FOUND')
  if (!target.deletedAt) return

  await db.update(user).set({ deletedAt: null }).where(eq(user.id, targetId))
}

export async function setImageBlurhash(userId: string, blurhash: string): Promise<boolean> {
  const updated = await db
    .update(user)
    .set({ imageBlurhash: blurhash })
    .where(eq(user.id, userId))
    .returning({ id: user.id })
  return updated.length > 0
}

/**
 * Repoint a user's avatar URL directly (worker context — the HEIC transcode job
 * has no Better Auth session to call `updateUser`). Returns false if the user is
 * gone. Mirrors {@link setImageBlurhash}.
 */
export async function setImage(userId: string, image: string): Promise<boolean> {
  const updated = await db
    .update(user)
    .set({ image })
    .where(eq(user.id, userId))
    .returning({ id: user.id })
  return updated.length > 0
}
