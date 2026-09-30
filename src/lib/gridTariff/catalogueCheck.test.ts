import { afterEach, beforeEach, expect, type MockInstance, test, vi } from 'vitest'
import { db } from '~/lib/db'
import { user } from '~/lib/db/schema'
import { queue } from '~/lib/effects'
import type { Catalogue, EltariffClient } from '~/lib/effects/eltariff'
import { EltariffError } from '~/lib/effects/eltariff'
import { createServerLogger } from '~/lib/logger/server'
import { setupDatabase } from '~test/setup'
import { runCatalogueCheck } from './catalogueCheck'

setupDatabase()

// Synthetic ID and ranges (never the real facility).
const FACILITY = '735999144123456789'
const ENV = { GRID_FACILITY_ID: FACILITY }
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

  const result = await runCatalogueCheck({ log, client, env: ENV })

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
  const result = await runCatalogueCheck({ log: capturingLogger().log, client, env: ENV })
  expect(result.outcome).toBe('covered')
  expect(publish).toHaveBeenCalledWith(
    'email_grid_tariff_available',
    expect.objectContaining({ companyName: null }),
  )
})

test('a failed publish is warned and not counted; the other admins still get theirs', async () => {
  await seedAdmins()
  publish.mockRejectedValueOnce(new Error('queue down'))
  const { log, entries } = capturingLogger()
  const client = fakeClient({ entries: [covering], invalidEntries: 0 })

  const result = await runCatalogueCheck({ log, client, env: ENV })

  expect(result).toMatchObject({ outcome: 'covered', notified: 1 })
  expect(publish).toHaveBeenCalledTimes(2)
  expect(entries().filter((e) => e.msg === 'grid tariff notice publish failed')).toHaveLength(1)
})

test('covered with no active admin notifies nobody', async () => {
  const client = fakeClient({ entries: [covering], invalidEntries: 0 })
  const result = await runCatalogueCheck({ log: capturingLogger().log, client, env: ENV })
  expect(result).toMatchObject({ outcome: 'covered', notified: 0 })
  expect(publish).not.toHaveBeenCalled()
})

test('not covered: no email, one info line', async () => {
  await seedAdmins()
  const { log, checkLines } = capturingLogger()
  const client = fakeClient({ entries: [elsewhere], invalidEntries: 0 })

  const result = await runCatalogueCheck({ log, client, env: ENV })

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

  const result = await runCatalogueCheck({ log, client, env: ENV })

  expect(result).toMatchObject({ outcome: 'inconclusive', invalidEntries: 2, notified: 0 })
  expect(publish).not.toHaveBeenCalled()
  expect(checkLines()).toEqual([expect.objectContaining({ level: WARN, outcome: 'inconclusive' })])
})

test('a match despite dropped entries is still covered', async () => {
  await seedAdmins()
  const client = fakeClient({ entries: [covering], invalidEntries: 3 })
  const result = await runCatalogueCheck({ log: capturingLogger().log, client, env: ENV })
  expect(result).toMatchObject({ outcome: 'covered', invalidEntries: 3, notified: 2 })
})

test.each([
  ['unset', {}],
  ['blank', { GRID_FACILITY_ID: ' ' }],
  ['malformed', { GRID_FACILITY_ID: '12345' }],
])('a %s GRID_FACILITY_ID is not_configured: nothing fetched or sent, warned', async (_label, env) => {
  await seedAdmins()
  const { log, checkLines } = capturingLogger()
  const client = fakeClient({ entries: [covering], invalidEntries: 0 })

  const result = await runCatalogueCheck({ log, client, env })

  expect(result).toMatchObject({ outcome: 'not_configured', code: 'not_configured' })
  expect(client.calls).toBe(0)
  expect(publish).not.toHaveBeenCalled()
  expect(checkLines()).toEqual([
    expect.objectContaining({ level: WARN, outcome: 'not_configured' }),
  ])
})

test('an unreadable catalogue is failed with its code: no email, warned', async () => {
  await seedAdmins()
  const { log, checkLines } = capturingLogger()
  const client = fakeClient(new EltariffError('unexpected_response', 'catalogue', 200))

  const result = await runCatalogueCheck({ log, client, env: ENV })

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

test('an unexpected error is rethrown and logged once at error level', async () => {
  const { log, checkLines } = capturingLogger()
  const boom = new Error('bug')
  const client = fakeClient(boom)

  await expect(runCatalogueCheck({ log, client, env: ENV })).rejects.toBe(boom)
  expect(checkLines()).toEqual([expect.objectContaining({ level: ERROR, outcome: 'error' })])
})

test('the facility ID never appears in the log output', async () => {
  await seedAdmins()
  const { log, lines } = capturingLogger()
  for (const client of [
    fakeClient({ entries: [covering], invalidEntries: 0 }),
    fakeClient({ entries: [elsewhere], invalidEntries: 1 }),
    fakeClient(new EltariffError('unreachable', 'catalogue')),
  ]) {
    await runCatalogueCheck({ log, client, env: ENV })
  }
  expect(lines.join('')).not.toContain(FACILITY)
})

test('the default client under VITEST fails closed as not_configured', async () => {
  const result = await runCatalogueCheck({ log: capturingLogger().log, env: ENV })
  expect(result).toMatchObject({ outcome: 'failed', code: 'not_configured' })
})
