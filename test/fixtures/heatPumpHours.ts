import { type HeatPumpHourInput, replaceDay, upsertUnits } from '~/lib/services/heatPump'

// SYNTHETIC heat pump readings for tests. Never put real readings in the repo (it's public).

const HOUR_MS = 3_600_000
const SEEN_AT = new Date('2026-10-08T12:00:00Z')

/** Inserts one unit per name (fake guids, model CS-HZ25ZKE); returns name → id. */
export async function seedUnits(...names: string[]): Promise<Record<string, string>> {
  const rows = await upsertUnits(
    names.map((name, i) => ({ guid: `CS-HZ25ZKE+000000000${i + 1}`, name, model: 'CS-HZ25ZKE' })),
    SEEN_AT,
  )
  return Object.fromEntries(rows.map((r) => [r.name, r.id]))
}

export type HourValues = Partial<Omit<HeatPumpHourInput, 'hourStart'>>

/**
 * Stores every UTC hour in [fromIso, toIso) for one unit: 0,1 kWh, all heating, 21 °C in, 0 °C out, unless `at(t, i)`
 * says otherwise; `at` returning null leaves that hour out (a gap). One `replaceDay` per UTC day, which replaces that
 * whole day: don't store the same unit's UTC day in two calls.
 */
export async function storeHours(
  heatPumpId: string,
  fromIso: string,
  toIso: string,
  at: (hourStartMs: number, i: number) => HourValues | null = () => ({}),
): Promise<void> {
  const days = new Map<string, HeatPumpHourInput[]>()
  for (let t = Date.parse(fromIso), i = 0; t < Date.parse(toIso); t += HOUR_MS, i++) {
    const values = at(t, i)
    if (values === null) continue
    const day = new Date(t).toISOString().slice(0, 10)
    const hours = days.get(day) ?? []
    hours.push({
      hourStart: new Date(t),
      energyKwh: 0.1,
      heatShare: 1,
      coolShare: 0,
      setpointC: 21,
      insideC: 21,
      outsideC: 0,
      ...values,
    })
    days.set(day, hours)
  }
  for (const [day, hours] of days) await replaceDay(heatPumpId, day, hours)
}
