import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { integrationSync } from '~/lib/db/schema'
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

test('credentialExpiryOf counts Stockholm calendar days, warning from 30 days', () => {
  expect(credentialExpiryOf(null, daysBefore(10))).toBeNull()
  expect(credentialExpiryOf(EXPIRES, daysBefore(31))).toEqual({
    expiresAt: EXPIRES,
    daysLeft: 31,
    warn: false,
    expired: false,
  })
  expect(credentialExpiryOf(EXPIRES, daysBefore(30))).toEqual({
    expiresAt: EXPIRES,
    daysLeft: 30,
    warn: true,
    expired: false,
  })
  // Part days don't round up: 10.2 days before is still 10 calendar days.
  expect(credentialExpiryOf(EXPIRES, daysBefore(10.2))).toMatchObject({ daysLeft: 10 })
  expect(credentialExpiryOf(EXPIRES, daysBefore(-1))).toMatchObject({
    daysLeft: 0,
    warn: true,
    expired: true,
  })
})

test('credentialExpiryOf: the expiry day itself is 0 days left until the instant passes', () => {
  const expires = new Date('2027-01-15T12:00:00Z')
  expect(credentialExpiryOf(expires, new Date('2027-01-15T07:00:00Z'))).toMatchObject({
    daysLeft: 0,
    expired: false,
    warn: true,
  })
  expect(credentialExpiryOf(expires, new Date('2027-01-14T09:00:00Z'))).toMatchObject({
    daysLeft: 1,
    expired: false,
  })
  expect(credentialExpiryOf(expires, new Date('2027-01-15T12:00:00Z'))).toMatchObject({
    daysLeft: 0,
    expired: true,
  })
})

test('credentialExpiryOf counts calendar days across the DST change', () => {
  // Sweden springs forward on 2027-03-28: 47 hours, but two calendar days.
  expect(
    credentialExpiryOf(new Date('2027-03-29T10:00:00Z'), new Date('2027-03-27T10:00:00Z')),
  ).toMatchObject({ daysLeft: 2 })
})

test('credentialExpiryOf counts days in Stockholm, not UTC', () => {
  // 23:30 UTC on the 15th is the 16th in Stockholm: one day after the 15th.
  expect(
    credentialExpiryOf(new Date('2027-01-15T23:30:00Z'), new Date('2027-01-15T10:00:00Z')),
  ).toMatchObject({ daysLeft: 1 })
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

test('two concurrent claims claim once (pins the conditional guard; the test pool serializes them)', async () => {
  await seed()
  await recordCredentialExpiry('skoda', EXPIRES)
  const claims = await Promise.all([
    claimCredentialReminder('skoda', daysBefore(29)),
    claimCredentialReminder('skoda', daysBefore(29)),
  ])
  const won = claims.filter((c) => c !== null)
  expect(won).toHaveLength(1)
  expect(won[0]?.previous).toBeNull()
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
    expired: false,
  })
  const member = await getHealth('skoda', { now: daysBefore(10), includeAdminDetail: false })
  expect(member.adminDetail).toBeNull()
})

test('a source without a credential expiry reports null', async () => {
  const health = await getHealth('zaptec', { now: daysBefore(10), includeAdminDetail: true })
  expect(health.adminDetail?.credentialExpiry).toBeNull()
})

test('releasing the 7-day claim restores 30 as the stored state', async () => {
  await seed()
  await recordCredentialExpiry('skoda', EXPIRES)
  await claimCredentialReminder('skoda', daysBefore(30))
  const claim = await claimCredentialReminder('skoda', daysBefore(7))
  if (!claim) throw new Error('expected a claim')
  await releaseCredentialReminder('skoda', claim)
  expect(await claimCredentialReminder('skoda', daysBefore(20))).toBeNull()
  expect(await claimCredentialReminder('skoda', daysBefore(6))).toEqual({
    days: 7,
    previous: 30,
    expiresAt: EXPIRES,
  })
})

test('releasing a stale claim is a no-op when a different claim is stored', async () => {
  await seed()
  await recordCredentialExpiry('skoda', EXPIRES)
  const stale = await claimCredentialReminder('skoda', daysBefore(30))
  if (!stale) throw new Error('expected a claim')
  await claimCredentialReminder('skoda', daysBefore(7))
  await releaseCredentialReminder('skoda', stale)
  expect(await claimCredentialReminder('skoda', daysBefore(1))).toBeNull()
})

test('releasing an old-expiry claim after a renewal leaves the renewed state alone', async () => {
  await seed()
  await recordCredentialExpiry('skoda', EXPIRES)
  const old = await claimCredentialReminder('skoda', daysBefore(30))
  if (!old) throw new Error('expected a claim')
  const renewed = new Date('2027-07-14T10:00:00Z')
  await recordCredentialExpiry('skoda', renewed)
  const at = new Date(renewed.getTime() - 30 * 86_400_000)
  expect(await claimCredentialReminder('skoda', at)).toMatchObject({ days: 30 })
  await releaseCredentialReminder('skoda', old)
  expect(await claimCredentialReminder('skoda', at)).toBeNull()
})

test('no row, or no recorded expiry, claims nothing and never throws', async () => {
  expect(await claimCredentialReminder('skoda', daysBefore(5))).toBeNull()
  await recordCredentialExpiry('skoda', EXPIRES)
  const health = await getHealth('skoda', { now: daysBefore(10), includeAdminDetail: true })
  expect(health.adminDetail?.credentialExpiry).toBeNull()
  await seed()
  expect(await claimCredentialReminder('skoda', daysBefore(5))).toBeNull()
})

test('credential state is scoped to its source', async () => {
  await seed()
  await beginAttempt('zaptec', { now: daysBefore(200) })
  await recordCredentialExpiry('skoda', EXPIRES)
  const claim = await claimCredentialReminder('skoda', daysBefore(7))
  if (!claim) throw new Error('expected a claim')
  await releaseCredentialReminder('skoda', claim)
  await claimCredentialReminder('skoda', daysBefore(7))
  const rows = await db.select().from(integrationSync).where(eq(integrationSync.source, 'zaptec'))
  expect(rows[0]?.credentialExpiresAt).toBeNull()
  expect(rows[0]?.credentialReminderDays).toBeNull()
})

test('an expired key claims the 7-day reminder once', async () => {
  await seed()
  await recordCredentialExpiry('skoda', EXPIRES)
  expect(await claimCredentialReminder('skoda', daysBefore(-1))).toMatchObject({ days: 7 })
  expect(await claimCredentialReminder('skoda', daysBefore(-2))).toBeNull()
})

test('a renewal to an earlier date after the 7-day reminder resets and allows a new claim', async () => {
  await seed()
  await recordCredentialExpiry('skoda', EXPIRES)
  await claimCredentialReminder('skoda', daysBefore(7))
  const earlier = daysBefore(10)
  await recordCredentialExpiry('skoda', earlier)
  expect(
    await claimCredentialReminder('skoda', new Date(earlier.getTime() - 5 * 86_400_000)),
  ).toMatchObject({ days: 7, previous: null, expiresAt: earlier })
})

test('a reminder falls due at Stockholm midnight, not a full 24 h multiple before expiry', async () => {
  await seed()
  await recordCredentialExpiry('skoda', EXPIRES)
  // 00:30 on 16 Dec in Stockholm: 30 calendar days before 15 Jan, though 30.5 days of time.
  expect(await claimCredentialReminder('skoda', new Date('2026-12-15T23:30:00Z'))).toMatchObject({
    days: 30,
  })
})
