import { expect, test } from 'vitest'
import type { SkodaClient } from '~/lib/effects/skoda'
import { createServerLogger } from '~/lib/logger/server'
import { setupDatabase } from '~test/setup'
import { runSkodaSync } from './sync'

setupDatabase()

// Its own file so the module-level once-per-instance flag in `./sync` starts fresh
// (each test file has its own module registry).
const NOW = new Date('2026-05-04T09:07:00Z')
const client: SkodaClient = {
  vehicleState: async () => ({
    keyExpiresAt: null,
    state: {
      chargingCapturedAt: null,
      chargingState: null,
      chargeType: null,
      plugState: null,
      chargePowerKw: null,
      socPercent: null,
      odometerKm: null,
      odometerCapturedAt: null,
      parking: null,
      missingParts: [],
      invalidParts: [],
    },
  }),
}

test('a missing home point warns exactly once per instance', async () => {
  const lines: string[] = []
  const log = createServerLogger({
    write(chunk: string) {
      lines.push(chunk)
      return true
    },
  })
  for (let i = 0; i < 2; i++) {
    await runSkodaSync({
      trigger: 'cron',
      now: () => new Date(NOW.getTime() + i * 1000),
      deps: { skoda: client, homePoint: null, log },
    })
  }
  const warns = lines
    .join('')
    .split('\n')
    .filter((l) => l.includes('skoda sync: home point unset or invalid, geofence off'))
  expect(warns).toHaveLength(1)
})
