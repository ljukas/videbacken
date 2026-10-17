import { afterEach, describe, expect, it } from 'vitest'
import { setupDatabase } from '~test/setup'
import { seedApprovedEmails } from './seedApprovedEmails'
import { addApproved, isApproved, listApproved } from './services/approvedEmail'

setupDatabase()

describe('seedApprovedEmails', () => {
  const originalEmails = process.env.INITIAL_ADMIN_EMAILS

  afterEach(() => {
    // Assigning undefined would store the string "undefined".
    if (originalEmails === undefined) delete process.env.INITIAL_ADMIN_EMAILS
    else process.env.INITIAL_ADMIN_EMAILS = originalEmails
  })

  it('seeds every listed email as an admin, normalized', async () => {
    process.env.INITIAL_ADMIN_EMAILS = ' First@Example.se , ,second@example.se'

    expect(await seedApprovedEmails()).toEqual({ listed: 2, seeded: 2 })
    expect(await isApproved('first@example.se')).toEqual({ role: 'admin' })
    expect(await isApproved('second@example.se')).toEqual({ role: 'admin' })
  })

  it('leaves an email that is already approved as it is', async () => {
    await addApproved({ email: 'person@example.se', role: 'user', addedByUserId: null })
    process.env.INITIAL_ADMIN_EMAILS = 'person@example.se,admin@example.se'

    expect(await seedApprovedEmails()).toEqual({ listed: 2, seeded: 1 })
    expect(await isApproved('person@example.se')).toEqual({ role: 'user' })
    // A second deploy seeds nothing.
    expect(await seedApprovedEmails()).toEqual({ listed: 2, seeded: 0 })
  })

  it('does nothing when INITIAL_ADMIN_EMAILS is unset', async () => {
    delete process.env.INITIAL_ADMIN_EMAILS

    expect(await seedApprovedEmails()).toEqual({ listed: 0, seeded: 0 })
    expect(await listApproved()).toEqual([])
  })
})
