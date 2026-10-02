import { expect, test } from 'vitest'
import { setupDatabase } from '~test/setup'
import {
  claimCredentialReminder,
  credentialExpiryOf,
  recordCredentialExpiry,
  releaseCredentialReminder,
} from './credential'
import { beginAttempt, getHealth } from './integrationSync'

setupDatabase()

const EXPIRES = new Date('2027-01-15T12:00:00.500Z')
const daysBefore = (d: number) => new Date(EXPIRES.getTime() - d * 86_400_000)
const seed = () => beginAttempt('skoda', { now: daysBefore(200) }) // creates the row

test('credentialExpiryOf: days left rounded up, warning from 30 days', () => {
  expect(credentialExpiryOf(null, daysBefore(10))).toBeNull()
  expect(credentialExpiryOf(EXPIRES, daysBefore(31))).toEqual({
    expiresAt: EXPIRES,
    daysLeft: 31,
    warn: false,
  })
  expect(credentialExpiryOf(EXPIRES, daysBefore(30))).toEqual({
    expiresAt: EXPIRES,
    daysLeft: 30,
    warn: true,
  })
  expect(credentialExpiryOf(EXPIRES, daysBefore(0.5))).toMatchObject({ daysLeft: 1, warn: true })
  expect(credentialExpiryOf(EXPIRES, daysBefore(-1))).toMatchObject({ daysLeft: 0, warn: true })
})

test('no reminder before 30 days; one at 30, none again, one at 7, none again', async () => {
  await seed()
  await recordCredentialExpiry('skoda', EXPIRES)
  expect(await claimCredentialReminder('skoda', daysBefore(31))).toBeNull()
  expect(await claimCredentialReminder('skoda', daysBefore(30))).toEqual({
    days: 30,
    expiresAt: EXPIRES,
    previous: null,
  })
  expect(await claimCredentialReminder('skoda', daysBefore(20))).toBeNull()
  expect(await claimCredentialReminder('skoda', daysBefore(7))).toEqual({
    days: 7,
    expiresAt: EXPIRES,
    previous: 30,
  })
  expect(await claimCredentialReminder('skoda', daysBefore(1))).toBeNull()
})

test('first seen at 5 days left claims only the 7-day reminder', async () => {
  await seed()
  await recordCredentialExpiry('skoda', EXPIRES)
  expect(await claimCredentialReminder('skoda', daysBefore(5))).toMatchObject({
    days: 7,
    previous: null,
  })
  expect(await claimCredentialReminder('skoda', daysBefore(4))).toBeNull()
})

test('two concurrent claims claim once', async () => {
  await seed()
  await recordCredentialExpiry('skoda', EXPIRES)
  const claims = await Promise.all([
    claimCredentialReminder('skoda', daysBefore(29)),
    claimCredentialReminder('skoda', daysBefore(29)),
  ])
  expect(claims.filter((c) => c !== null)).toHaveLength(1)
})

test('a released claim is claimed again on the next poll', async () => {
  await seed()
  await recordCredentialExpiry('skoda', EXPIRES)
  const claim = await claimCredentialReminder('skoda', daysBefore(7))
  if (!claim) throw new Error('expected a claim')
  await releaseCredentialReminder('skoda', claim)
  expect(await claimCredentialReminder('skoda', daysBefore(6))).toMatchObject({ days: 7 })
})

test('a renewed key resets the reminders; the same expiry again does not', async () => {
  await seed()
  await recordCredentialExpiry('skoda', EXPIRES)
  await claimCredentialReminder('skoda', daysBefore(30))
  await recordCredentialExpiry('skoda', EXPIRES)
  expect(await claimCredentialReminder('skoda', daysBefore(29))).toBeNull()
  const renewed = new Date('2027-07-14T10:00:00Z')
  await recordCredentialExpiry('skoda', renewed)
  expect(await claimCredentialReminder('skoda', daysBefore(29))).toBeNull() // ~6 months left
  expect(
    await claimCredentialReminder('skoda', new Date(renewed.getTime() - 30 * 86_400_000)),
  ).toMatchObject({
    days: 30,
    expiresAt: renewed,
  })
})

test('a null expiry (header missing) keeps the stored one; only admins see it', async () => {
  await seed()
  await recordCredentialExpiry('skoda', EXPIRES)
  await recordCredentialExpiry('skoda', null)
  const admin = await getHealth('skoda', { now: daysBefore(10), includeAdminDetail: true })
  expect(admin.adminDetail?.credentialExpiry).toEqual({
    expiresAt: EXPIRES,
    daysLeft: 10,
    warn: true,
  })
  const member = await getHealth('skoda', { now: daysBefore(10), includeAdminDetail: false })
  expect(member.adminDetail).toBeNull()
})

test('a source without a credential expiry reports null', async () => {
  const health = await getHealth('zaptec', { now: daysBefore(10), includeAdminDetail: true })
  expect(health.adminDetail?.credentialExpiry).toBeNull()
})
