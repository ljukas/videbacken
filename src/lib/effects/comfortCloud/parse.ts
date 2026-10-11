import { z } from 'zod'
import { issuePath, summarizeIssuePaths } from '~/lib/issuePaths'
import { isUtcDay, isUtcMonth, utcDayBounds } from '~/lib/time/utc'
import type {
  ComfortCloudDay,
  ComfortCloudHistory,
  ComfortCloudHour,
  ComfortCloudUnit,
} from './comfortCloud'
import { ComfortCloudError, type ComfortCloudOp } from './errors'

/** Comfort Cloud's "no value" in any numeric history field (hours not reached, `cost` without a tariff). */
export const NO_VALUE = -255
/** Device types upstream treats as not an air conditioner: Aquarea (2), the HWS tank (11). */
const NON_AC_DEVICE_TYPES = new Set(['2', '11'])
const HOUR_MS = 3_600_000
const MAX_GROUPS = 50
const MAX_DEVICES = 50
/** A day answer has 24 rows, a month answer ≤ 31: anything far beyond is not a history. */
const MAX_HISTORY_ROWS = 40
/** `temperatureUnit` of an account set to Celsius (the probe's value); anything else fails the call. */
const CELSIUS = 0

function unexpected(op: ComfortCloudOp, message: string): ComfortCloudError {
  return new ComfortCloudError('unexpected_response', op, undefined, { message })
}

function parse<T>(op: ComfortCloudOp, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const at = summarizeIssuePaths(parsed.error.issues.map((i) => issuePath(i.path)))
  throw unexpected(op, `Comfort Cloud ${op} response has an unexpected shape at: ${at}`)
}

export function parseJson(op: ComfortCloudOp, text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw unexpected(op, `Comfort Cloud ${op} response is not valid JSON`)
  }
}

// ---- login ------------------------------------------------------------------

const tokenSchema = z.object({ access_token: z.string().min(1).max(16_384) })

/** `/oauth/token` → the access token (the refresh and id tokens are ignored, never kept). */
export function parseToken(value: unknown): string {
  return parse('login', tokenSchema, value).access_token
}

const accLoginSchema = z.object({ clientId: z.string().min(1).max(256) })

/** `/auth/v2/login` → the `clientId` sent as `x-client-id`. */
export function parseAccLogin(value: unknown): string {
  return parse('login', accLoginSchema, value).clientId
}

// ---- units ------------------------------------------------------------------

const optionalText = (max: number) => z.string().max(max).nullish()
const deviceSchema = z.object({
  deviceGuid: z.string().min(1).max(128),
  deviceType: optionalText(16),
  deviceName: optionalText(200),
  deviceModuleNumber: optionalText(100),
  parameters: z.record(z.string(), z.unknown()).nullish(),
})
const deviceListSchema = z.array(deviceSchema.nullable()).max(MAX_DEVICES).nullish()
const groupsSchema = z.object({
  groupList: z
    .array(z.object({ deviceList: deviceListSchema, deviceIdList: deviceListSchema }))
    .max(MAX_GROUPS)
    .nullish(),
})

/** Every air conditioner of every group, once, in Comfort Cloud's order. */
export function parseUnits(value: unknown): ComfortCloudUnit[] {
  const { groupList } = parse('units', groupsSchema, value)
  const units = new Map<string, ComfortCloudUnit>()
  for (const group of groupList ?? []) {
    // Upstream: `deviceList or deviceIdList` (an empty list falls through too).
    for (const device of (group.deviceList?.length ? group.deviceList : group.deviceIdList) ?? []) {
      // Upstream's `is_valid`: an air conditioner has the `parameters` key (its value may be null);
      // Aquarea and HWS are skipped.
      if (!device || !('parameters' in device) || NON_AC_DEVICE_TYPES.has(device.deviceType ?? ''))
        continue
      if (units.has(device.deviceGuid)) continue
      const model = device.deviceModuleNumber?.trim() ?? ''
      const name = device.deviceName?.trim() || model || 'Comfort Cloud'
      units.set(device.deviceGuid, { guid: device.deviceGuid, name, model })
    }
  }
  return [...units.values()]
}

// ---- history ----------------------------------------------------------------

const numeric = z.number()
const rowSchema = z.object({
  dataTime: z.string().max(32),
  consumption: numeric,
  heatConsumptionRate: numeric.nullish(),
  coolConsumptionRate: numeric.nullish(),
  averageSettingTemp: numeric.nullish(),
  averageInsideTemp: numeric.nullish(),
  averageOutsideTemp: numeric.nullish(),
})
const historySchema = z.object({
  temperatureUnit: z.int(),
  deviceRegisterTime: z.string().regex(/^\d{8}$/),
  historyDataList: z.array(rowSchema).max(MAX_HISTORY_ROWS),
})

/** null for "no value" or an absent field; anything else as sent (the service range-checks it). */
const orNull = (v: number | null | undefined): number | null =>
  v === undefined || v === null || v === NO_VALUE ? null : v

/** 'YYYYMMDD' → 'YYYY-MM-DD' (not validated). */
const dashed = (compact: string) =>
  `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`

function readHistory(value: unknown) {
  const history = parse('history', historySchema, value)
  // The columns are °C: an account set to Fahrenheit would store °F in them.
  if (history.temperatureUnit !== CELSIUS) {
    throw unexpected(
      'history',
      'Comfort Cloud reports temperatures in a unit other than Celsius (temperatureUnit); set the account to °C in the Comfort Cloud app',
    )
  }
  const registeredOn = dashed(history.deviceRegisterTime)
  if (!isUtcDay(registeredOn)) {
    throw unexpected('history', 'Comfort Cloud history has an impossible deviceRegisterTime')
  }
  return { registeredOn, rows: history.historyDataList }
}

/**
 * A `dataMode` 0 answer for UTC `utcDay`. Every row must be one hour of that day, once; rows
 * with `consumption < 0` (an hour not reached yet) are dropped.
 */
export function parseDayHistory(
  utcDay: string,
  value: unknown,
): ComfortCloudHistory<ComfortCloudHour> {
  const { startMs } = utcDayBounds(utcDay)
  const compact = utcDay.replaceAll('-', '')
  const { registeredOn, rows } = readHistory(value)
  const seen = new Set<number>()
  const hours: ComfortCloudHour[] = []
  for (const [i, row] of rows.entries()) {
    const match = /^(\d{8}) (\d{2})$/.exec(row.dataTime)
    const hour = match ? Number(match[2]) : Number.NaN
    if (!match || match[1] !== compact || !(hour <= 23)) {
      throw unexpected(
        'history',
        `Comfort Cloud day history row ${i} is not an hour of the requested day`,
      )
    }
    if (seen.has(hour))
      throw unexpected('history', `Comfort Cloud day history row ${i} repeats an hour`)
    seen.add(hour)
    if (row.consumption < 0) continue
    hours.push({
      hourStart: new Date(startMs + hour * HOUR_MS),
      energyKwh: row.consumption,
      heatShare: orNull(row.heatConsumptionRate),
      coolShare: orNull(row.coolConsumptionRate),
      setpointC: orNull(row.averageSettingTemp),
      insideC: orNull(row.averageInsideTemp),
      outsideC: orNull(row.averageOutsideTemp),
    })
  }
  hours.sort((a, b) => a.hourStart.getTime() - b.hourStart.getTime())
  return { registeredOn, rows: hours }
}

/**
 * A `dataMode` 2 answer for UTC `utcMonth` ('YYYY-MM'). Every row must be one day of that month,
 * once; days with `consumption < 0` are dropped.
 */
export function parseMonthHistory(
  utcMonth: string,
  value: unknown,
): ComfortCloudHistory<ComfortCloudDay> {
  if (!isUtcMonth(utcMonth)) throw new RangeError(`Not a YYYY-MM month: ${utcMonth}`)
  const compact = utcMonth.replace('-', '')
  const { registeredOn, rows } = readHistory(value)
  const seen = new Set<string>()
  const days: ComfortCloudDay[] = []
  for (const [i, row] of rows.entries()) {
    const day = dashed(row.dataTime)
    if (!/^\d{8}$/.test(row.dataTime) || !row.dataTime.startsWith(compact) || !isUtcDay(day)) {
      throw unexpected(
        'history',
        `Comfort Cloud month history row ${i} is not a day of the requested month`,
      )
    }
    if (seen.has(day))
      throw unexpected('history', `Comfort Cloud month history row ${i} repeats a day`)
    seen.add(day)
    if (row.consumption < 0) continue
    days.push({ day, energyKwh: row.consumption })
  }
  days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  return { registeredOn, rows: days }
}
