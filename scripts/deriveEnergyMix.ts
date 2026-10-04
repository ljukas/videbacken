// One-off re-derive of the energy mix and battery pool (ADR-0023): after a
// derive fix, or at roadmap checkpoint 3. Runs deriveFrom(day) once, from
// --from or (default) the first house reading's Stockholm day, i.e. all of
// history. Idempotent: a derive rewrites everything it covers.
//
//   read -rs DATABASE_URL && DATABASE_URL="$DATABASE_URL" \
//     bun --no-env-file scripts/deriveEnergyMix.ts [--from YYYY-MM-DD] [--yes]
//
// The target is always given explicitly, never read from env files:
// --no-env-file stops Bun auto-loading .env/.env.local, and `vercel env pull`
// leaves production's DATABASE_URL in .env.local (CLAUDE.md → Gotchas).
// Without --yes it only prints the target, the first reading and the measured
// battery capacity C; it writes nothing.
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: { from: { type: 'string' }, yes: { type: 'boolean', default: false } },
})
const url = process.env.DATABASE_URL
if (!url) {
  console.error('Set DATABASE_URL on the command line (see the header comment).')
  process.exit(1)
}
if (values.from !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.from)) {
  console.error(`--from must be a YYYY-MM-DD day, got ${values.from}`)
  process.exit(1)
}
let target: URL
try {
  target = new URL(url)
} catch {
  console.error('DATABASE_URL is not a valid URL.')
  process.exit(1)
}
// The connection string's query can override what the authority says.
const overrides = ['host', 'hostaddr', 'port', 'dbname'].filter((k) => target.searchParams.has(k))
if (overrides.length > 0) {
  console.error(
    `DATABASE_URL overrides the target in its query (${overrides.join(', ')}): refused.`,
  )
  process.exit(1)
}
// The user names the Supabase project (postgres.<project-ref>): the pooler host
// is shared by every project in the region. Never the password.
console.log(
  `Target database: ${decodeURIComponent(target.username)}@${target.hostname}:${target.port || '5432'}${target.pathname}`,
)

// Imported only now: ~/lib/db reads DATABASE_URL when it loads.
const { deriveFrom } = await import('~/lib/houseEnergy/derive')
const { BATTERY_CAPACITY_KWH } = await import('~/lib/houseEnergy/mix/pool')
const { logger } = await import('~/lib/logger/server')
const houseEnergyService = await import('~/lib/services/houseEnergy')
const { isStockholmDay, stockholmDayOf } = await import('~/lib/time/stockholm')

const first = await houseEnergyService.firstReadingAt()
if (!first) {
  console.log('No house readings stored: nothing to derive.')
  process.exit(0)
}
console.log(
  `First reading: ${first.toISOString()} (Stockholm day ${stockholmDayOf(first.getTime())})`,
)
const measured = await houseEnergyService.measureBatteryCapacity()
if (measured) {
  console.log(
    `Measured battery capacity: ${measured.capacityKwh.toFixed(2)} kWh per 100 % SoC over ${measured.pairs} pairs ` +
      `(${measured.from.toISOString()} → ${measured.to.toISOString()}); code uses ${BATTERY_CAPACITY_KWH}`,
  )
}

const from = values.from ?? stockholmDayOf(first.getTime())
if (!isStockholmDay(from) || from > stockholmDayOf(Date.now())) {
  console.error(`--from must be a real day, today or earlier, got ${from}`)
  process.exit(1)
}
if (!values.yes) {
  console.log(`Dry run. Re-run with --yes to derive from ${from}.`)
  process.exit(0)
}
const result = await deriveFrom(from, { log: logger })
// The derive starts a day early, and further back for a session spanning
// midnight or a missing checkpoint: say where it actually started.
console.log(
  `Derived (requested ${from}, started ${result.fromDay}): ${result.days} pool days, ` +
    `${result.sessions} sessions, ${result.deriveMs} ms.`,
)
process.exit(0)
