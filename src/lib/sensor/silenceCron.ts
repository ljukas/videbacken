import { verifyCronSecret } from '~/lib/integrations/cron'
import { logger } from '~/lib/logger/server'
import { evaluateDeviceSilence, listSilenceDeviceIds } from '~/lib/services/sensorAlert'
import { publishAlertTransitions } from './publishAlertTransitions'

export type SilenceCheckSummary = {
  devices: number
  failed: number
  fired: number
  recovered: number
}

/**
 * Judges every device with an enabled silence rule, one at a time (ADR-0028). A device whose
 * evaluation throws is logged and counted; the others still run. Everything is awaited here:
 * the emails are published before the cron answers.
 */
export async function checkSilence(now: Date): Promise<SilenceCheckSummary> {
  const started = Date.now()
  const deviceIds = await listSilenceDeviceIds()
  let failed = 0
  let fired = 0
  let recovered = 0
  for (const deviceId of deviceIds) {
    try {
      const transitions = await evaluateDeviceSilence(deviceId, now)
      for (const t of transitions) {
        if (t.transition === 'fired') fired++
        else recovered++
      }
      await publishAlertTransitions(deviceId, transitions)
    } catch (error) {
      failed++
      logger.error('sensor silence evaluation failed', { deviceId, error })
    }
  }
  const summary = { devices: deviceIds.length, failed, fired, recovered }
  logger.info('sensor silence check', { ...summary, durationMs: Date.now() - started })
  return summary
}

/** The hourly silence cron's entrypoint: secret-gated, 200 with the summary, 500 only when listing fails. */
export async function handleSilenceCron(request: Request): Promise<Response> {
  if (!verifyCronSecret(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return new Response(null, { status: 401 })
  }
  try {
    return Response.json(await checkSilence(new Date()))
  } catch (error) {
    logger.error('sensor silence check failed', { error })
    return new Response(null, { status: 500 })
  }
}
