// Client-safe sensor alert vocabulary (ADR-0028). Dependency-free on purpose: the schema imports
// it by relative path (drizzle-kit loads that without the `~` alias) and so do the browser
// components. Copy (labels) lives with the components.
// Changing a kind, a direction or a bound changes the rendered DB CHECK text: run `bun run db:generate`.

export const SENSOR_ALERT_KINDS = ['temperature', 'humidity', 'battery', 'silence'] as const
export type SensorAlertKind = (typeof SENSOR_ALERT_KINDS)[number]

export const SENSOR_ALERT_DIRECTIONS = ['below', 'above'] as const
export type SensorAlertDirection = (typeof SENSOR_ALERT_DIRECTIONS)[number]

/** Consecutive merged readings that must breach a threshold before an alert fires. */
export const ALERT_COUNT_MIN = 2
export const ALERT_COUNT_MAX = 10
export const ALERT_COUNT_DEFAULT = 2

/** Hours without a reading before a silence alert fires. */
export const SILENCE_HOURS_MIN = 3
export const SILENCE_HOURS_MAX = 72
export const SILENCE_HOURS_DEFAULT = 6

/** Thresholds: temperature in °C (half degrees), humidity and battery in whole percent. */
export const TEMPERATURE_MIN = -40
export const TEMPERATURE_MAX = 60
export const HUMIDITY_MIN = 1
export const HUMIDITY_MAX = 99
export const BATTERY_MIN = 5
export const BATTERY_MAX = 95
export const BATTERY_DEFAULT = 20

/** Readings closer than this to a group's first reading are one reading (a sensor's burst). */
export const MERGE_WINDOW_MS = 10 * 60_000

/** A rule as the browser sees it; the fields a kind doesn't use are null. */
export type SensorAlertRuleDto = {
  id: string
  deviceId: string
  kind: SensorAlertKind
  enabled: boolean
  /** temperature/humidity: set; battery: 'below'; silence: null. */
  direction: SensorAlertDirection | null
  /** °C or %; silence: null. */
  threshold: number | null
  /** silence: null. */
  count: number | null
  /** Only silence. */
  silenceHours: number | null
}
