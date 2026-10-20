// The alert rule input, shared by the procedure and the form (ADR-0028). One branch per kind:
// a field a kind doesn't use is stripped, never stored.
import { z } from 'zod'
import {
  ALERT_COUNT_MAX,
  ALERT_COUNT_MIN,
  BATTERY_MAX,
  BATTERY_MIN,
  HUMIDITY_MAX,
  HUMIDITY_MIN,
  SENSOR_ALERT_DIRECTIONS,
  SILENCE_HOURS_MAX,
  SILENCE_HOURS_MIN,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
} from './alerts'

const deviceId = z.uuid()
const direction = z.enum(SENSOR_ALERT_DIRECTIONS)
const count = z.number().int().min(ALERT_COUNT_MIN).max(ALERT_COUNT_MAX)
const wholePercent = (min: number, max: number) => z.number().int().min(min).max(max)

export const sensorAlertRuleInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('temperature'),
    deviceId,
    direction,
    threshold: z
      .number()
      .min(TEMPERATURE_MIN)
      .max(TEMPERATURE_MAX)
      .refine((t) => Number.isInteger(t * 2), 'whole or half degrees'),
    count,
  }),
  z.object({
    kind: z.literal('humidity'),
    deviceId,
    direction,
    threshold: wholePercent(HUMIDITY_MIN, HUMIDITY_MAX),
    count,
  }),
  z.object({
    kind: z.literal('battery'),
    deviceId,
    threshold: wholePercent(BATTERY_MIN, BATTERY_MAX),
    count,
  }),
  z.object({
    kind: z.literal('silence'),
    deviceId,
    silenceHours: z.number().int().min(SILENCE_HOURS_MIN).max(SILENCE_HOURS_MAX),
  }),
])
export type SensorAlertRuleInput = z.infer<typeof sensorAlertRuleInput>
