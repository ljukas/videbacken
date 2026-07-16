import { and, asc, count, eq, isNotNull, isNull } from 'drizzle-orm'
import { db } from '~/lib/db'
import { user } from '~/lib/db/schema'
import {
  addApproved,
  ApprovedEmailDomainError,
  isApproved,
  listApproved,
  normalizeEmail,
  removeApproved,
  type ApprovedEmailRow,
} from '~/lib/services/approvedEmail'
import { UserDomainError } from './errors'

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type DbOrTx = typeof db | DbTransaction

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
  emailVerified: boolean
  // When the user finished (or skipped through) the onboarding wizard; null
  // until then. The _authenticated loader routes null-onboardedAt users to
  // /onboarding. See ADR-0017.
  onboardedAt: Date | null
}

// Email is intentionally absent: it is the sign-in identity (Google + magic
// link both resolve by email), so it is immutable after invite (an admin typo
// would silently lock the user out — see ADR-0017). To change an address:
// revoke + re-invite.
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
  onboardedAt: user.onboardedAt,
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

// Any *active* (non-deleted) user row for this email — used to tell "still
// pending" apart from "already accepted" without re-deriving it from
// `emailVerified` (which no longer means "invite accepted"; see ADR-0017
// amendment). A soft-deleted row (a previously revoked user) doesn't count —
// its email is free to be re-invited as a fresh pending entry.
async function findActiveIdByEmail(email: string): Promise<string | null> {
  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.email, email), isNull(user.deletedAt)))
    .limit(1)
  return row?.id ?? null
}

/**
 * Invite = add the email to the `approved_email` allowlist. No `user` row is
 * created here — first sign-in (Google or magic-link, both gated on the
 * allowlist) is what creates it, stamped with the role recorded on this row
 * (see `resolveSignInDecision` / `databaseHooks.user.create.before` in
 * auth.ts). Replaces the old model's cold-inserted unverified user row (see
 * ADR-0017 amendment).
 *
 * Check-first (ADR-0002): `addApproved` already guards duplicates itself
 * (case-insensitive), so a re-invite of an email that's already on the
 * allowlist — whether still pending or already an active user — maps to
 * `EMAIL_ALREADY_APPROVED` instead of a raw unique-constraint error.
 *
 * Restore-on-reinvite: if this email previously belonged to a `user` row that
 * `revokeUser` soft-deleted, clear that `deletedAt` stamp and re-apply the
 * (possibly new) role now. Without this, the allowlist would say "approved"
 * again while `deletedAt` still says "gone" — the `_authenticated` guard
 * bounces the returning user to /login forever with no error shown to anyone.
 * `onboardedAt` is left untouched so a returning user isn't forced back
 * through the wizard. A never-signed-in email has no `user` row yet, so the
 * update below is a no-op and role applies on first sign-in as usual (via the
 * `create.before` hook).
 */
export async function inviteUser(input: {
  email: string
  role: 'user' | 'admin'
  actorUserId: string
}): Promise<ApprovedEmailRow> {
  let created: ApprovedEmailRow
  try {
    created = await addApproved({
      email: input.email,
      role: input.role,
      addedByUserId: input.actorUserId,
    })
  } catch (err) {
    if (err instanceof ApprovedEmailDomainError) throw new UserDomainError('EMAIL_ALREADY_APPROVED')
    throw err
  }

  await db
    .update(user)
    .set({ deletedAt: null, role: created.role })
    .where(and(eq(user.email, created.email), isNotNull(user.deletedAt)))

  return created
}

/**
 * Guard a resend: the email must currently be a *pending* invite — approved,
 * but with no active user row yet. `NOT_FOUND` covers an email that was never
 * invited (or whose invite was already revoked); `ALREADY_ACCEPTED` covers one
 * that has since signed in and has nothing left to resend.
 */
export async function assertPendingInvite(
  email: string,
): Promise<{ email: string; role: 'user' | 'admin' }> {
  const normalized = normalizeEmail(email)
  const approval = await isApproved(normalized)
  if (!approval) throw new UserDomainError('NOT_FOUND')
  if (await findActiveIdByEmail(normalized)) throw new UserDomainError('ALREADY_ACCEPTED')
  return { email: normalized, role: approval.role }
}

/**
 * Revoke = remove the allowlist entry and, if the email already became a real
 * `user` (an active sign-in happened), soft-delete that row too — same guards
 * as the old delete (`CANNOT_ACT_ON_SELF`, last-admin). Session revocation is
 * an auth-boundary effect (`auth.api`) and lives in the procedure, not here —
 * see ADR-0017 amendment. Returns the soft-deleted user's id (if any) so the
 * procedure knows whether there are sessions to revoke.
 *
 * `NOT_FOUND` when the email was never approved and has no user row either —
 * nothing to revoke (guards a stale/double-click on the admin's list).
 */
export async function revokeUser(input: {
  email: string
  actorUserId: string
}): Promise<{ userId: string | null }> {
  const normalized = normalizeEmail(input.email)
  const wasApproved = await isApproved(normalized)

  const userId = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select(userSelection)
      .from(user)
      .where(eq(user.email, normalized))
      .limit(1)

    if (!existing && !wasApproved) throw new UserDomainError('NOT_FOUND')
    if (!existing || existing.deletedAt) return existing?.id ?? null

    if (existing.id === input.actorUserId) throw new UserDomainError('CANNOT_ACT_ON_SELF')
    if (existing.role === 'admin' && (await countAdmins(tx)) <= 1) {
      throw new UserDomainError('LAST_ADMIN')
    }

    await tx.update(user).set({ deletedAt: new Date() }).where(eq(user.id, existing.id))
    return existing.id
  })

  await removeApproved(normalized)
  return { userId }
}

export type UserListRow = {
  status: 'active' | 'pending'
  id: string
  email: string
  name: string | null
  phone: string | null
  role: 'user' | 'admin'
  image: string | null
  imageBlurhash: string | null
  createdAt: Date
}

/**
 * The `/users` directory: active `user` rows (not deleted) plus `approved_email`
 * rows that haven't been claimed by a sign-in yet, each tagged with `status`.
 * Replaces the old model's "pending = emailVerified false" derivation — pending
 * is now "approved but no active user row" (see ADR-0017 amendment).
 */
export async function listUsersAndPending(): Promise<Array<UserListRow>> {
  const [activeUsers, approvedRows] = await Promise.all([listAll(), listApproved()])
  const activeEmails = new Set(activeUsers.map((u) => u.email))

  const active: Array<UserListRow> = activeUsers.map((u) => ({
    status: 'active',
    id: u.id,
    email: u.email,
    name: u.name,
    phone: u.phone,
    role: u.role === 'admin' ? 'admin' : 'user',
    image: u.image,
    imageBlurhash: u.imageBlurhash,
    createdAt: u.createdAt,
  }))

  const pending: Array<UserListRow> = approvedRows
    .filter((row) => !activeEmails.has(row.email))
    .map((row) => ({
      status: 'pending',
      id: row.id,
      email: row.email,
      name: null,
      phone: null,
      role: row.role,
      image: null,
      imageBlurhash: null,
      createdAt: row.createdAt,
    }))

  return [...active, ...pending]
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
