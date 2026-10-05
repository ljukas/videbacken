import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, expect, type MockInstance, test, vi } from 'vitest'
import { CredentialsUnreadableError } from '~/lib/credentials/crypto'
import { db } from '~/lib/db'
import { user } from '~/lib/db/schema'
import { queue } from '~/lib/effects'
import type { Catalogue, EltariffClient } from '~/lib/effects/eltariff'
import { EltariffError } from '~/lib/effects/eltariff'
import { createServerLogger } from '~/lib/logger/server'
import * as integrationCredentialService from '~/lib/services/integrationCredential'
import * as userService from '~/lib/services/user'
import { setupDatabase } from '~test/setup'
import { runCatalogueCheck } from './catalogueCheck'

setupDatabase()

// Synthetic ID and ranges (never the real facility).
const FACILITY = '735999144123456789'
const id = (v?: string) => async () => v
const covering = {
  meteringPointIdFrom: '735999144000000000',
  meteringPointIdTo: '735999144999999999',
  companyName: 'Nät AB',
}
const elsewhere = {
  meteringPointIdFrom: '735999169000000000',
  meteringPointIdTo: '735999169999999999',
  companyName: 'Annat Nät AB',
}

function capturingLogger() {
  const lines: string[] = []
  const log = createServerLogger({
    write(chunk: string) {
      lines.push(chunk)
      return true
    },
  })
  const entries = () =>
    lines
      .join('')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown> & { msg: string; level: number })
  const checkLines = () => entries().filter((e) => e.msg === 'grid tariff catalogue check')
  return { log, lines, entries, checkLines }
}

const INFO = 30
const WARN = 40
const ERROR = 50

function fakeClient(result: Catalogue | Error): EltariffClient & { calls: number } {
  const c = {
    calls: 0,
    async catalogue() {
      c.calls++
      if (result instanceof Error) throw result
      return result
    },
  }
  return c
}

let publish: MockInstance<typeof queue.publish>
beforeEach(() => {
  publish = vi.spyOn(queue, 'publish').mockResolvedValue(undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function seedAdmins() {
  await db.insert(user).values([
    { name: 'A', email: 'a@test.videbacken.local', role: 'admin' },
    { name: 'B', email: 'b@test.videbacken.local', role: 'admin' },
    { name: 'M', email: 'm@test.videbacken.local', role: 'user' },
    { name: 'G', email: 'g@test.videbacken.local', role: 'admin', deletedAt: new Date() },
  ])
}

test('covered: emails each active admin the company name, and logs one info line', async () => {
  await seedAdmins()
  const { log, checkLines } = capturingLogger()
  const client = fakeClient({ entries: [elsewhere, covering], invalidEntries: 0 })

  const result = await runCatalogueCheck({ log, client, facilityId: id(FACILITY) })

  expect(result).toEqual({
    outcome: 'covered',
    code: null,
    entries: 2,
    invalidEntries: 0,
    notified: 2,
  })
  expect(publish.mock.calls).toEqual([
    [
      'email_grid_tariff_available',
      { to: 'a@test.videbacken.local', companyName: 'Nät AB', locale: 'sv' },
    ],
    [
      'email_grid_tariff_available',
      { to: 'b@test.videbacken.local', companyName: 'Nät AB', locale: 'sv' },
    ],
  ])
  const [line] = checkLines()
  expect(checkLines()).toHaveLength(1)
  expect(line).toMatchObject({ level: INFO, outcome: 'covered', company: 'Nät AB', notified: 2 })
})

test('covered by an unnamed entry still notifies, with a null name', async () => {
  await seedAdmins()
  const client = fakeClient({ entries: [{ ...covering, companyName: null }], invalidEntries: 0 })
  const result = await runCatalogueCheck({
    log: capturingLogger().log,
    client,
    facilityId: id(FACILITY),
  })
  expect(result.outcome).toBe('covered')
  expect(publish).toHaveBeenCalledWith(
    'email_grid_tariff_available',
    expect.objectContaining({ companyName: null }),
  )
})

test('a failed publish is warned and not counted; the other admins still get theirs', async () => {
  await seedAdmins()
  publish.mockRejectedValueOnce(new Error('queue down'))
  const { log, entries, checkLines } = capturingLogger()
  const client = fakeClient({ entries: [covering], invalidEntries: 0 })

  const result = await runCatalogueCheck({ log, client, facilityId: id(FACILITY) })

  expect(result).toMatchObject({ outcome: 'covered', notified: 1 })
  expect(publish).toHaveBeenCalledTimes(2)
  expect(entries().filter((e) => e.msg === 'grid tariff notice publish failed')).toEqual([
    expect.objectContaining({ level: WARN }),
  ])
  // A notice that didn't reach everyone makes the run line a warning too.
  expect(checkLines()).toEqual([
    expect.objectContaining({ level: WARN, outcome: 'covered', notified: 1, publishFailures: 1 }),
  ])
})

test('covered but every publish failed: notified 0, warned', async () => {
  await seedAdmins()
  publish.mockRejectedValue(new Error('queue down'))
  const { log, checkLines } = capturingLogger()
  const client = fakeClient({ entries: [covering], invalidEntries: 0 })

  const result = await runCatalogueCheck({ log, client, facilityId: id(FACILITY) })

  expect(result).toMatchObject({ outcome: 'covered', notified: 0 })
  expect(checkLines()).toEqual([
    expect.objectContaining({ level: WARN, outcome: 'covered', publishFailures: 2 }),
  ])
})

test('covered with no active admin notifies nobody, warned', async () => {
  const { log, checkLines } = capturingLogger()
  const client = fakeClient({ entries: [covering], invalidEntries: 0 })
  const result = await runCatalogueCheck({ log, client, facilityId: id(FACILITY) })
  expect(result).toMatchObject({ outcome: 'covered', notified: 0 })
  expect(publish).not.toHaveBeenCalled()
  expect(checkLines()).toEqual([expect.objectContaining({ level: WARN, outcome: 'covered' })])
})

test('an admin lookup failure is rethrown (a 500) and logged as error, not covered', async () => {
  await seedAdmins()
  const dbDown = new Error('db down')
  vi.spyOn(userService, 'listActiveAdmins').mockRejectedValueOnce(dbDown)
  const { log, checkLines } = capturingLogger()
  const client = fakeClient({ entries: [covering], invalidEntries: 0 })

  await expect(runCatalogueCheck({ log, client, facilityId: id(FACILITY) })).rejects.toBe(dbDown)
  expect(publish).not.toHaveBeenCalled()
  expect(checkLines()).toEqual([
    expect.objectContaining({ level: ERROR, outcome: 'error', error: expect.anything() }),
  ])
})

test('not covered: no email, one info line', async () => {
  await seedAdmins()
  const { log, checkLines } = capturingLogger()
  const client = fakeClient({ entries: [elsewhere], invalidEntries: 0 })

  const result = await runCatalogueCheck({ log, client, facilityId: id(FACILITY) })

  expect(result).toEqual({
    outcome: 'not_covered',
    code: null,
    entries: 1,
    invalidEntries: 0,
    notified: 0,
  })
  expect(publish).not.toHaveBeenCalled()
  expect(checkLines()).toEqual([
    expect.objectContaining({ level: INFO, outcome: 'not_covered', company: null }),
  ])
})

test('no match with dropped entries is inconclusive and warned, not "not covered"', async () => {
  await seedAdmins()
  const { log, checkLines } = capturingLogger()
  const client = fakeClient({ entries: [elsewhere], invalidEntries: 2 })

  const result = await runCatalogueCheck({ log, client, facilityId: id(FACILITY) })

  expect(result).toMatchObject({ outcome: 'inconclusive', invalidEntries: 2, notified: 0 })
  expect(publish).not.toHaveBeenCalled()
  expect(checkLines()).toEqual([expect.objectContaining({ level: WARN, outcome: 'inconclusive' })])
})

test('a match despite dropped entries is still covered', async () => {
  await seedAdmins()
  const client = fakeClient({ entries: [covering], invalidEntries: 3 })
  const result = await runCatalogueCheck({
    log: capturingLogger().log,
    client,
    facilityId: id(FACILITY),
  })
  expect(result).toMatchObject({ outcome: 'covered', invalidEntries: 3, notified: 2 })
})

test.each([
  ['unset', undefined],
  ['blank', ' '],
  ['malformed', '12345'],
])('a %s facility ID is not_configured: nothing fetched or sent, warned', async (_label, value) => {
  await seedAdmins()
  const { log, checkLines } = capturingLogger()
  const client = fakeClient({ entries: [covering], invalidEntries: 0 })

  const result = await runCatalogueCheck({ log, client, facilityId: id(value) })

  expect(result).toMatchObject({ outcome: 'not_configured', code: 'not_configured' })
  expect(client.calls).toBe(0)
  expect(publish).not.toHaveBeenCalled()
  expect(checkLines()).toEqual([
    expect.objectContaining({ level: WARN, outcome: 'not_configured' }),
  ])
})

test('an unreadable stored ID is failed / credentials_unreadable: nothing fetched, logged at error', async () => {
  await seedAdmins()
  const { log, checkLines } = capturingLogger()
  const client = fakeClient({ entries: [covering], invalidEntries: 0 })
  const facilityId = async () => {
    throw new CredentialsUnreadableError('gridTariff', 'invalid')
  }

  const result = await runCatalogueCheck({ log, client, facilityId })

  expect(result).toEqual({
    outcome: 'failed',
    code: 'credentials_unreadable',
    entries: 0,
    invalidEntries: 0,
    notified: 0,
  })
  expect(client.calls).toBe(0)
  expect(publish).not.toHaveBeenCalled()
  expect(checkLines()).toEqual([
    expect.objectContaining({ level: ERROR, outcome: 'failed', code: 'credentials_unreadable' }),
  ])
})

test('the default reads the stored ID over GRID_FACILITY_ID', async () => {
  await seedAdmins()
  vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY', randomBytes(32).toString('base64'))
  // A valid env ID in the other range: only the stored one may be matched.
  vi.stubEnv('GRID_FACILITY_ID', '735999169123456789')
  await integrationCredentialService.set('gridTariff', { facilityId: FACILITY }, null)

  const covered = await runCatalogueCheck({
    log: capturingLogger().log,
    client: fakeClient({ entries: [covering], invalidEntries: 0 }),
  })
  const elsewhereOnly = await runCatalogueCheck({
    log: capturingLogger().log,
    client: fakeClient({ entries: [elsewhere], invalidEntries: 0 }),
  })

  expect(covered).toMatchObject({ outcome: 'covered', notified: 2 })
  expect(elsewhereOnly).toMatchObject({ outcome: 'not_covered' })
})

test('an unreadable catalogue is failed with its code: no email, warned', async () => {
  await seedAdmins()
  const { log, checkLines } = capturingLogger()
  const client = fakeClient(new EltariffError('unexpected_response', 'catalogue', 200))

  const result = await runCatalogueCheck({ log, client, facilityId: id(FACILITY) })

  expect(result).toEqual({
    outcome: 'failed',
    code: 'unexpected_response',
    entries: 0,
    invalidEntries: 0,
    notified: 0,
  })
  expect(publish).not.toHaveBeenCalled()
  expect(checkLines()).toEqual([
    expect.objectContaining({ level: WARN, outcome: 'failed', code: 'unexpected_response' }),
  ])
})

test.each([
  'forbidden',
  'rate_limited',
  'unreachable',
] as const)('a %s catalogue read is failed with that code', async (code) => {
  await seedAdmins()
  const client = fakeClient(new EltariffError(code, 'catalogue'))
  const result = await runCatalogueCheck({
    log: capturingLogger().log,
    client,
    facilityId: id(FACILITY),
  })
  expect(result).toMatchObject({ outcome: 'failed', code, notified: 0 })
  expect(publish).not.toHaveBeenCalled()
})

test('an unexpected error is rethrown and logged once at error level', async () => {
  const { log, checkLines } = capturingLogger()
  const boom = new Error('bug')
  const client = fakeClient(boom)

  await expect(runCatalogueCheck({ log, client, facilityId: id(FACILITY) })).rejects.toBe(boom)
  expect(checkLines()).toEqual([
    expect.objectContaining({ level: ERROR, outcome: 'error', error: expect.anything() }),
  ])
})

test('the facility ID never appears in the log output, on any path', async () => {
  await seedAdmins()
  const { log, lines } = capturingLogger()
  const runs = [
    fakeClient({ entries: [covering], invalidEntries: 0 }),
    fakeClient({ entries: [elsewhere], invalidEntries: 0 }),
    fakeClient({ entries: [elsewhere], invalidEntries: 1 }),
    fakeClient(new EltariffError('unreachable', 'catalogue')),
  ]
  for (const client of runs) await runCatalogueCheck({ log, client, facilityId: id(FACILITY) })
  // A publish failure and an unexpected throw both log their error objects.
  publish.mockRejectedValueOnce(new Error('queue down'))
  await runCatalogueCheck({ log, client: runs[0], facilityId: id(FACILITY) })
  await runCatalogueCheck({
    log,
    client: fakeClient(new Error('bug')),
    facilityId: id(FACILITY),
  }).catch(() => {})

  expect(lines.length).toBeGreaterThan(0)
  expect(lines.join('')).not.toContain(FACILITY)
})

test('the default client under VITEST fails closed as not_configured', async () => {
  const result = await runCatalogueCheck({ log: capturingLogger().log, facilityId: id(FACILITY) })
  expect(result).toMatchObject({ outcome: 'failed', code: 'not_configured' })
})
