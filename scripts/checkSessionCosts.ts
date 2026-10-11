// Checkpoint 3 of the server-latency roadmap (ADR-0020, amended 2026-10-11):
// prices every current counted session on read and compares it with its
// stored month rows. Read-only: it never writes back.
//
//   read -rs DATABASE_URL && DATABASE_URL="$DATABASE_URL" \
//     bun --no-env-file scripts/checkSessionCosts.ts
//
// The target is always given explicitly, never read from env files
// (CLAUDE.md → Gotchas). Exits 1 when a current session differs by more than
// 1e-9 (relative) in any field. The stored rows and the inputs are two reads:
// a session bumped and repriced between them can show as an offender, so
// re-run before believing one.
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
const { PRICING_VERSION } = await import('~/lib/evCharging/cost')
const { priceSessions } = await import('~/lib/evCharging/costing')
const sessionCost = await import('~/lib/services/sessionCost')

// One statement: the month rows of every current counted session. The stale
// count is only information (a second read).
const current = await sessionCost.listCurrentMonths({ pricingVersion: PRICING_VERSION })
const staleCount = (await sessionCost.listStale({ pricingVersion: PRICING_VERSION })).length
const storedBySession = new Map(current.map((c) => [c.sessionId, c.months]))
const priced = await priceSessions([...storedBySession.keys()])

let worst = 0
const offenders: string[] = []
for (const p of priced) {
  const stored = new Map(
    (storedBySession.get(p.sessionId) ?? []).map((m) => [m.year * 100 + m.month, m.totals]),
  )
  const keys = new Set([...stored.keys(), ...p.months.keys()])
  for (const key of keys) {
    const s = stored.get(key)
    const t = p.months.get(key)
    if (!s || !t) {
      offenders.push(`${p.sessionId} ${key}: month only ${s ? 'stored' : 'priced'}`)
      continue
    }
    for (const field of Object.keys(t) as (keyof typeof t)[]) {
      const rel = Math.abs(s[field] - t[field]) / Math.max(1, Math.abs(t[field]))
      worst = Math.max(worst, rel)
      if (rel > 1e-9) offenders.push(`${p.sessionId} ${key} ${field}: ${s[field]} vs ${t[field]}`)
    }
  }
}
console.log(
  `Current sessions compared: ${priced.length}; stale (not compared): ${staleCount}; ` +
    `largest relative difference: ${worst}`,
)
for (const o of offenders.slice(0, 50)) console.log(`  ${o}`)
process.exit(offenders.length > 0 ? 1 : 0)

// A module, for the top-level awaits.
export {}
