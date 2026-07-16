import { describe, expect, it } from 'vitest'
import { setupDatabase } from '~test/setup'
import { addApproved } from './approvedEmail'
import { resolveSignInDecision } from './gate'

setupDatabase()

describe('resolveSignInDecision', () => {
  it('denies an email not on the allowlist', async () => {
    expect(await resolveSignInDecision('stranger@example.se')).toEqual({
      allowed: false,
      role: 'user',
    })
  })

  it('allows an approved user with its recorded role', async () => {
    await addApproved({ email: 'boss@example.se', role: 'admin', addedByUserId: null })
    expect(await resolveSignInDecision('BOSS@example.se')).toEqual({ allowed: true, role: 'admin' })
  })
})
