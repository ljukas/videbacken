// Checkpoint 3 of the server-latency roadmap (ADR-0020, amended 2026-10-11):
// prices every counted session on read and compares it with its stored month
// rows. Read-only: it never writes back.
//
//   read -rs DATABASE_URL && DATABASE_URL="$DATABASE_URL" \
//     bun --no-env-file scripts/checkSessionCosts.ts
//
// The target is always given explicitly, never read from env files
// (CLAUDE.md → Gotchas). Exits 1 when a current session differs by more than
// 1e-9 (relative) in any field.
const url = process.env.DATABASE_URL
if (!url) {
  console.error('Set DATABASE_URL on the command line (see the header comment).')
  process.exit(1)
}
let target: URL
try {
  target = new URL(url)
} catch {
  console.error('DATABASE_URL is not a valid URL.')
  process.exit(1)
}
console.log(
  `Target database: ${decodeURIComponent(target.username)}@${target.hostname}:${target.port || '5432'}${target.pathname}`,
)

// Imported only now: ~/lib/db reads DATABASE_URL when it loads.
const { db } = await import('~/lib/db')
const { evSessionCostMonth } = await import('~/lib/db/schema')
const { PRICING_VERSION } = await import('~/lib/evCharging/cost')
const { priceSessions } = await import('~/lib/evCharging/costing')
const sessionCost = await import('~/lib/services/sessionCost')

const stale = await sessionCost.listStale({ pricingVersion: PRICING_VERSION })
const rows = await db.select().from(evSessionCostMonth)
const staleIds = new Set(stale.map((s) => s.sessionId))
const storedBySession = Map.groupBy(
  rows.filter((r) => !staleIds.has(r.sessionId)),
  (r) => r.sessionId,
)
const priced = await priceSessions([...storedBySession.keys()])

let worst = 0
const offenders: string[] = []
for (const p of priced) {
  const stored = new Map(
    (storedBySession.get(p.sessionId) ?? []).map((r) => [r.year * 100 + r.month, r]),
  )
  const keys = new Set([...stored.keys(), ...p.months.keys()])
  for (const key of keys) {
    const s = stored.get(key)
    const t = p.months.get(key)
    if (!s || !t) {
      offenders.push(`${p.sessionId} ${key}: month only ${s ? 'stored' : 'priced'}`)
      continue
    }
    for (const [field, value] of Object.entries(t)) {
      const diff = Math.abs((s as Record<string, number>)[field] - value)
      const rel = diff / Math.max(1, Math.abs(value))
      worst = Math.max(worst, rel)
      if (rel > 1e-9)
        offenders.push(`${p.sessionId} ${key} ${field}: ${s[field as keyof typeof s]} vs ${value}`)
    }
  }
}
console.log(
  `Current sessions compared: ${priced.length}; stale (not compared): ${stale.length}; ` +
    `largest relative difference: ${worst}`,
)
for (const o of offenders.slice(0, 50)) console.log(`  ${o}`)
process.exit(offenders.length > 0 ? 1 : 0)
