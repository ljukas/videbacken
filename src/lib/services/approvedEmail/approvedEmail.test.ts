import { describe, expect, it } from 'vitest'
import { setupDatabase } from '~test/setup'
import {
  addApproved,
  isApproved,
  listApproved,
  normalizeEmail,
  removeApproved,
} from './approvedEmail'

setupDatabase()

describe('approvedEmail service', () => {
  it('normalizes email to lowercase', () => {
    expect(normalizeEmail('Mail@Example.SE')).toBe('mail@example.se')
  })

  it('addApproved then isApproved returns the role', async () => {
    await addApproved({ email: 'Person@Example.se', role: 'user', addedByUserId: null })
    expect(await isApproved('person@example.se')).toEqual({ role: 'user' })
  })

  it('isApproved returns null for an unknown email', async () => {
    expect(await isApproved('nobody@example.se')).toBeNull()
  })

  it('addApproved rejects a duplicate (case-insensitive)', async () => {
    await addApproved({ email: 'dup@example.se', role: 'admin', addedByUserId: null })
    await expect(
      addApproved({ email: 'DUP@example.se', role: 'user', addedByUserId: null }),
    ).rejects.toMatchObject({ code: 'EMAIL_ALREADY_APPROVED' })
  })

  it('removeApproved deletes the row', async () => {
    await addApproved({ email: 'gone@example.se', role: 'user', addedByUserId: null })
    await removeApproved('gone@example.se')
    expect(await isApproved('gone@example.se')).toBeNull()
  })

  it('listApproved returns all rows', async () => {
    await addApproved({ email: 'a@example.se', role: 'user', addedByUserId: null })
    await addApproved({ email: 'b@example.se', role: 'admin', addedByUserId: null })
    const rows = await listApproved()
    expect(rows.map((r) => r.email).sort()).toEqual(['a@example.se', 'b@example.se'])
  })
})
