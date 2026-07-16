import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { db } from '~/lib/db'
import { ownershipAssignment } from '~/lib/db/schema'
import * as userService from '~/lib/services/user'
import { SHARE_CODES, type ShareCode } from '~/lib/shares/codes'
import { ShareDomainError } from './errors'

export type AssignmentRow = {
  id: string
  shareCode: ShareCode
  userId: string
  actorUserId: string | null
  assignedFrom: Date
  assignedTo: Date | null
}

export type ShareWithCurrentOwnerRow = {
  shareCode: ShareCode
  currentUserId: string | null
}

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type DbOrTx = typeof db | DbTransaction

const assignmentSelection = {
  id: ownershipAssignment.id,
  shareCode: ownershipAssignment.shareCode,
  userId: ownershipAssignment.userId,
  actorUserId: ownershipAssignment.actorUserId,
  assignedFrom: ownershipAssignment.assignedFrom,
  assignedTo: ownershipAssignment.assignedTo,
}

// Admin grid view: every share A→J with its current owner (or null). The
// share_code enum is the share (ADR-0018), so the 10 rows are driven from
// SHARE_CODES in code and only active assignments are read from the DB.
export async function listSharesWithCurrentOwner(): Promise<Array<ShareWithCurrentOwnerRow>> {
  const active = await db
    .select({ shareCode: ownershipAssignment.shareCode, userId: ownershipAssignment.userId })
    .from(ownershipAssignment)
    .where(isNull(ownershipAssignment.assignedTo))
  const byShare = new Map(active.map((r) => [r.shareCode, r.userId]))
  return SHARE_CODES.map((shareCode) => ({
    shareCode,
    currentUserId: byShare.get(shareCode) ?? null,
  }))
}

export async function getCurrentOwner(shareCode: ShareCode): Promise<string | null> {
  const active = await getActiveAssignment(shareCode)
  return active?.userId ?? null
}

async function getActiveAssignment(
  shareCode: ShareCode,
  dbOrTx: DbOrTx = db,
): Promise<AssignmentRow | null> {
  const [row] = await dbOrTx
    .select(assignmentSelection)
    .from(ownershipAssignment)
    .where(
      and(eq(ownershipAssignment.shareCode, shareCode), isNull(ownershipAssignment.assignedTo)),
    )
    .limit(1)
  return row ?? null
}

export async function listCurrentSharesForUser(userId: string): Promise<Array<ShareCode>> {
  const rows = await db
    .select({ shareCode: ownershipAssignment.shareCode })
    .from(ownershipAssignment)
    .where(and(eq(ownershipAssignment.userId, userId), isNull(ownershipAssignment.assignedTo)))
    .orderBy(asc(ownershipAssignment.shareCode))
  return rows.map((r) => r.shareCode)
}

// Per-share history, newest first. Rows are only ever closed, never deleted,
// so this is the share's complete ownership timeline (powers the admin
// history sheet).
export async function listShareHistory(shareCode: ShareCode): Promise<Array<AssignmentRow>> {
  return db
    .select(assignmentSelection)
    .from(ownershipAssignment)
    .where(eq(ownershipAssignment.shareCode, shareCode))
    .orderBy(desc(ownershipAssignment.assignedFrom))
}

export type AssignShareInput = {
  shareCode: ShareCode
  userId: string
  from: Date
}

export type UnassignShareInput = {
  shareCode: ShareCode
  on: Date
}

// Admin entry-points: check-first invariants inside the mutation tx
// (ADR-0002); typed ShareDomainError so the procedure layer can map to
// Swedish ORPCError. Concurrent-admin check-then-write races are accepted
// at this scale; the partial unique index is the silent backstop.
export async function assignShareAsAdmin(
  input: AssignShareInput,
  ctx: { actorUserId?: string | null } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    // Active-user check; a deleted user can never be assigned. Must run on
    // `tx`: with the test pool pinned to one connection, an outer-`db` query
    // inside this transaction would wait on the connection the tx holds.
    const u = await userService.findActiveById(input.userId, tx)
    if (!u) throw new ShareDomainError('USER_NOT_FOUND')

    const existing = await getActiveAssignment(input.shareCode, tx)
    if (existing && existing.userId === input.userId) {
      throw new ShareDomainError('ALREADY_CURRENT_OWNER')
    }
    if (existing && input.from.getTime() <= existing.assignedFrom.getTime()) {
      throw new ShareDomainError('FROM_DATE_NOT_AFTER_CURRENT')
    }

    if (existing) {
      await tx
        .update(ownershipAssignment)
        .set({ assignedTo: input.from })
        .where(
          and(
            eq(ownershipAssignment.shareCode, input.shareCode),
            isNull(ownershipAssignment.assignedTo),
          ),
        )
    }
    await tx.insert(ownershipAssignment).values({
      shareCode: input.shareCode,
      userId: input.userId,
      actorUserId: ctx.actorUserId ?? null,
      assignedFrom: input.from,
      assignedTo: null,
    })
  })
}

export async function unassignShareAsAdmin(input: UnassignShareInput): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await getActiveAssignment(input.shareCode, tx)
    if (!existing) throw new ShareDomainError('NOT_ASSIGNED')
    if (input.on.getTime() <= existing.assignedFrom.getTime()) {
      throw new ShareDomainError('DATE_NOT_AFTER_CURRENT')
    }
    await tx
      .update(ownershipAssignment)
      .set({ assignedTo: input.on })
      .where(
        and(
          eq(ownershipAssignment.shareCode, input.shareCode),
          isNull(ownershipAssignment.assignedTo),
        ),
      )
  })
}
