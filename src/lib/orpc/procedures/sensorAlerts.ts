import { z } from 'zod'
import { protectedProcedure } from '~/lib/orpc/context'
import { type SensorAlertRuleInput, sensorAlertRuleInput } from '~/lib/sensor/alertRuleInput'
import * as sensorAlertService from '~/lib/services/sensorAlert'
import { SensorAlertDomainError, type SensorAlertDomainErrorCode } from '~/lib/services/sensorAlert'

// Alert rules are the signed-in user's own (ADR-0028 extends ADR-0017's own-account exception):
// every procedure is protectedProcedure and the owner is only ever `context.user.id`; no input
// carries a user id.
const sensorAlertErrors = {
  RULE_NOT_FOUND: { status: 404 },
  UNKNOWN_SENSOR: { status: 422 },
} satisfies Record<SensorAlertDomainErrorCode, { status: number }>

const updateInput = sensorAlertRuleInput.and(z.object({ id: z.uuid() }))

// Maps a domain error to its typed oRPC error (code only; the client owns the copy, see
// sensorAlertErrorMessage). Anything else propagates (a 500).
function mapAlertError(
  err: unknown,
  errors: { [K in SensorAlertDomainErrorCode]: () => Error },
): never {
  if (err instanceof SensorAlertDomainError) throw errors[err.code]()
  throw err
}

export const sensorAlertsRouter = {
  list: protectedProcedure.handler(async ({ context }) => {
    const started = performance.now()
    let rulesDone = started
    const [rules, typicalGapMinutes] = await Promise.all([
      sensorAlertService.listOwnRules(context.user.id).then((r) => {
        rulesDone = performance.now()
        return r
      }),
      sensorAlertService.typicalGapsByDevice(new Date()).then((r) => {
        if (context.timings) context.timings.alertHintsMs = Math.round(performance.now() - started)
        return r
      }),
    ])
    if (context.timings) context.timings.alertRulesMs = Math.round(rulesDone - started)
    return { rules, typicalGapMinutes }
  }),

  create: protectedProcedure
    .errors(sensorAlertErrors)
    .input(sensorAlertRuleInput)
    .handler(async ({ input, context, errors }) => {
      try {
        const rule = await sensorAlertService.createRule(context.user.id, input)
        context.log.info('user created sensor alert rule', {
          ruleId: rule.id,
          deviceId: rule.deviceId,
          kind: rule.kind,
        })
        return rule
      } catch (err) {
        mapAlertError(err, errors)
      }
    }),

  update: protectedProcedure
    .errors(sensorAlertErrors)
    .input(updateInput)
    .handler(async ({ input, context, errors }) => {
      const { id, ...rule }: { id: string } & SensorAlertRuleInput = input
      try {
        const updated = await sensorAlertService.updateRule(context.user.id, id, rule)
        context.log.info('user updated sensor alert rule', {
          ruleId: id,
          deviceId: updated.deviceId,
          kind: updated.kind,
        })
        return updated
      } catch (err) {
        mapAlertError(err, errors)
      }
    }),

  setEnabled: protectedProcedure
    .errors(sensorAlertErrors)
    .input(z.object({ id: z.uuid(), enabled: z.boolean() }))
    .handler(async ({ input, context, errors }) => {
      try {
        const rule = await sensorAlertService.setRuleEnabled(
          context.user.id,
          input.id,
          input.enabled,
        )
        context.log.info(`user ${input.enabled ? 'enabled' : 'disabled'} sensor alert rule`, {
          ruleId: rule.id,
          deviceId: rule.deviceId,
          kind: rule.kind,
        })
        return rule
      } catch (err) {
        mapAlertError(err, errors)
      }
    }),

  delete: protectedProcedure
    .errors(sensorAlertErrors)
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ input, context, errors }) => {
      try {
        await sensorAlertService.deleteRule(context.user.id, input.id)
        context.log.info('user deleted sensor alert rule', { ruleId: input.id })
      } catch (err) {
        mapAlertError(err, errors)
      }
    }),
}
