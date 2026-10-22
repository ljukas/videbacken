import { afterEach, describe, expect, test, vi } from 'vitest'
import { queue } from '~/lib/effects'
import { logger } from '~/lib/logger/server'
import type { SensorAlertTransition } from '~/lib/services/sensorAlert'
import { publishAlertTransitions } from './publishAlertTransitions'

const SINCE = new Date('2026-10-22T18:00:00.000Z')
const ENDED = new Date('2026-10-23T02:30:00.000Z')
const base = {
  ruleId: 'r1',
  eventId: 'e1',
  to: 'a@test.videbacken.local',
  sensorName: 'Frysen',
  since: SINCE,
}

const silence: SensorAlertTransition = {
  ...base,
  kind: 'silence',
  silenceHours: 6,
  transition: 'recovered',
  endedAt: ENDED,
}
const value: SensorAlertTransition = {
  ...base,
  kind: 'temperature',
  direction: 'below',
  threshold: 5,
  count: 2,
  value: 4.8,
  transition: 'fired',
  endedAt: null,
}

describe('publishAlertTransitions', () => {
  afterEach(() => vi.restoreAllMocks())

  test('a silence transition publishes no value fields', async () => {
    const publish = vi.spyOn(queue, 'publish').mockResolvedValue(undefined as never)
    await publishAlertTransitions('d1', [silence])
    expect(publish).toHaveBeenCalledTimes(1)
    const [topic, payload] = publish.mock.calls[0]
    expect(topic).toBe('email_sensor_alert')
    expect(payload).toStrictEqual({
      to: 'a@test.videbacken.local',
      locale: 'sv',
      transition: 'recovered',
      sensorName: 'Frysen',
      kind: 'silence',
      silenceHours: 6,
      since: SINCE.toISOString(),
      endedAt: ENDED.toISOString(),
    })
  })

  test('a value transition publishes the step 2 payload', async () => {
    const publish = vi.spyOn(queue, 'publish').mockResolvedValue(undefined as never)
    await publishAlertTransitions('d1', [value])
    expect(publish.mock.calls[0][1]).toStrictEqual({
      to: 'a@test.videbacken.local',
      locale: 'sv',
      transition: 'fired',
      sensorName: 'Frysen',
      kind: 'temperature',
      direction: 'below',
      threshold: 5,
      count: 2,
      value: 4.8,
      since: SINCE.toISOString(),
      endedAt: null,
    })
  })

  test('a rejecting publish is logged and the next transition still publishes', async () => {
    const publish = vi
      .spyOn(queue, 'publish')
      .mockRejectedValueOnce(new Error('queue down'))
      .mockResolvedValue(undefined as never)
    const logError = vi.spyOn(logger, 'error')
    await expect(publishAlertTransitions('d1', [value, silence])).resolves.toBeUndefined()
    expect(publish).toHaveBeenCalledTimes(2)
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith(
      'sensor alert email publish failed',
      expect.objectContaining({ ruleId: 'r1', eventId: 'e1', transition: 'fired' }),
    )
  })
})
