import { afterEach, describe, expect, it } from 'vitest'
import { setupDatabase } from '~test/setup'
import { seedApprovedEmails } from './seedApprovedEmails'
import { addApproved, isApproved, listApproved, removeApproved } from './services/approvedEmail'

setupDatabase()

describe('seedApprovedEmails', () => {
  const originalEmails = process.env.INITIAL_ADMIN_EMAILS

  afterEach(() => {
    // Assigning undefined would store the string "undefined".
    if (originalEmails === undefined) delete process.env.INITIAL_ADMIN_EMAILS
    else process.env.INITIAL_ADMIN_EMAILS = originalEmails
  })

  it('seeds every listed email as an admin, normalized, while no admin is approved', async () => {
    process.env.INITIAL_ADMIN_EMAILS = ' First@Example.se , ,second@example.se'

    expect(await seedApprovedEmails()).toEqual({ listed: 2, seeded: 2, skipped: false })
    expect(await isApproved('first@example.se')).toEqual({ role: 'admin' })
    expect(await isApproved('second@example.se')).toEqual({ role: 'admin' })
  })

  it('leaves an email that is already approved as it is', async () => {
    await addApproved({ email: 'person@example.se', role: 'user', addedByUserId: null })
    process.env.INITIAL_ADMIN_EMAILS = 'person@example.se,admin@example.se'

    expect(await seedApprovedEmails()).toEqual({ listed: 2, seeded: 1, skipped: false })
    expect(await isApproved('person@example.se')).toEqual({ role: 'user' })
  })

  it('only bootstraps: once an admin is approved, a revoked seed email stays revoked', async () => {
    process.env.INITIAL_ADMIN_EMAILS = 'owner@example.se,former@example.se'
    await seedApprovedEmails()
    // An admin revokes one of the seeded emails at /admin.
    await removeApproved('former@example.se')

    // The next deploy seeds nothing.
    expect(await seedApprovedEmails()).toEqual({ listed: 2, seeded: 0, skipped: true })
    expect(await isApproved('former@example.se')).toBeNull()
  })

  it('seeds again once the allowlist holds no admin (a lockout)', async () => {
    await addApproved({ email: 'person@example.se', role: 'user', addedByUserId: null })
    process.env.INITIAL_ADMIN_EMAILS = 'owner@example.se'

    expect(await seedApprovedEmails()).toEqual({ listed: 1, seeded: 1, skipped: false })
    expect(await isApproved('owner@example.se')).toEqual({ role: 'admin' })
  })

  it('does nothing when INITIAL_ADMIN_EMAILS is unset', async () => {
    delete process.env.INITIAL_ADMIN_EMAILS

    expect(await seedApprovedEmails()).toEqual({ listed: 0, seeded: 0, skipped: false })
    expect(await listApproved()).toEqual([])
  })
})
