import { desc, eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { sensorDevice, sensorReading } from '~/lib/db/schema'
import { SensorDomainError } from './errors'

// Lowercase + keep hex only, so "AA:BB:CC...", "aa-bb-cc..." and "aabbcc..."
// all resolve to one device.
export function normalizeMac(raw: string): string {
  return raw.toLowerCase().replace(/[^a-f0-9]/g, '')
}

// A normalized MAC must be a full 12-hex identity (Shelly emits a bare
// `${config.sys.device.mac}` of exactly 12 hex chars). Rejecting anything else
// stops garbage input (which strips to "" or a stub) from silently colliding
// distinct callers onto one phantom device row on the unique `mac` column.
const MAC_RE = /^[0-9a-f]{12}$/
export function isValidMac(normalized: string): boolean {
  return MAC_RE.test(normalized)
}

function displayNameFor(name: string | null, mac: string): string {
  return name ?? `Sensor ${mac.slice(-4)}`
}

export type RecordReadingInput = {
  mac: string
  temperatureC?: number | null
  humidityPct?: number | null
  batteryPct?: number | null
}

// Auto-registers the device by MAC (unknown → new unnamed row), inserts one
// reading, and bumps last-seen (+ battery when present) — all in one tx. A
// webhook without a battery reading keeps the previously-stored battery.
export async function recordReading(input: RecordReadingInput): Promise<{ deviceId: string }> {
  const mac = normalizeMac(input.mac)
  if (!isValidMac(mac)) throw new SensorDomainError('INVALID_MAC')
  const now = new Date()
  return db.transaction(async (tx) => {
    const updateSet: { lastSeenAt: Date; batteryPct?: number } = { lastSeenAt: now }
    if (input.batteryPct != null) updateSet.batteryPct = input.batteryPct
    const [device] = await tx
      .insert(sensorDevice)
      .values({ mac, lastSeenAt: now, batteryPct: input.batteryPct ?? null })
      .onConflictDoUpdate({ target: sensorDevice.mac, set: updateSet })
      .returning({ id: sensorDevice.id })
    // recordedAt set explicitly to the same `now` as lastSeenAt so the device's
    // last-seen and its newest reading timestamp are identical for one event.
    await tx.insert(sensorReading).values({
      deviceId: device.id,
      temperatureC: input.temperatureC ?? null,
      humidityPct: input.humidityPct ?? null,
      batteryPct: input.batteryPct ?? null,
      recordedAt: now,
    })
    return { deviceId: device.id }
  })
}

export type SensorReadingSnapshot = {
  temperatureC: number | null
  humidityPct: number | null
  recordedAt: Date
}

export type SensorDeviceRow = {
  id: string
  mac: string
  name: string | null
  location: string | null
  displayName: string
  batteryPct: number | null
  lastSeenAt: Date | null
  latest: SensorReadingSnapshot | null
}

// Devices (creation order) + their single most-recent reading, for the
// current-value tiles. Two queries + an in-memory join — trivial at 4 devices,
// and avoids any lateral-join API surprises.
export async function listDevices(): Promise<SensorDeviceRow[]> {
  // `id` tiebreaks createdAt so ordering is deterministic even if two devices
  // auto-register in the same instant.
  const devices = await db
    .select()
    .from(sensorDevice)
    .orderBy(sensorDevice.createdAt, sensorDevice.id)

  // DISTINCT ON (device_id) + this ORDER BY takes the newest reading per device;
  // `desc(id)` tiebreaks an exact recorded_at collision so the pick is stable.
  const latestRows = await db
    .selectDistinctOn([sensorReading.deviceId], {
      deviceId: sensorReading.deviceId,
      temperatureC: sensorReading.temperatureC,
      humidityPct: sensorReading.humidityPct,
      recordedAt: sensorReading.recordedAt,
    })
    .from(sensorReading)
    .orderBy(sensorReading.deviceId, desc(sensorReading.recordedAt), desc(sensorReading.id))

  const latestByDevice = new Map(latestRows.map((r) => [r.deviceId, r]))

  return devices.map((d) => {
    const latest = latestByDevice.get(d.id)
    return {
      id: d.id,
      mac: d.mac,
      name: d.name,
      location: d.location,
      displayName: displayNameFor(d.name, d.mac),
      batteryPct: d.batteryPct,
      lastSeenAt: d.lastSeenAt,
      latest: latest
        ? {
            temperatureC: latest.temperatureC,
            humidityPct: latest.humidityPct,
            recordedAt: latest.recordedAt,
          }
        : null,
    }
  })
}

export async function renameDevice(
  id: string,
  patch: { name: string | null; location: string | null },
): Promise<void> {
  const updated = await db
    .update(sensorDevice)
    .set({ name: patch.name, location: patch.location })
    .where(eq(sensorDevice.id, id))
    .returning({ id: sensorDevice.id })
  if (updated.length === 0) throw new SensorDomainError('DEVICE_NOT_FOUND')
}

export async function deleteDevice(id: string): Promise<void> {
  const deleted = await db
    .delete(sensorDevice)
    .where(eq(sensorDevice.id, id))
    .returning({ id: sensorDevice.id })
  if (deleted.length === 0) throw new SensorDomainError('DEVICE_NOT_FOUND')
}
