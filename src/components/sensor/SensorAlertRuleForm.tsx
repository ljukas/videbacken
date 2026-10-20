import { isDefinedError } from '@orpc/client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { Button } from '~/components/ui/button'
import { ResponsiveDialogFooter } from '~/components/ui/responsive-dialog'
import { useAppForm, useStore } from '~/hooks/form'
import { orpc } from '~/lib/orpc/client'
import { sensorAlertErrorMessage } from '~/lib/orpc/sensorAlertErrorMessage'
import { parseDecimal } from '~/lib/parseDecimal'
import { sensorAlertRuleInput } from '~/lib/sensor/alertRuleInput'
import {
  ALERT_COUNT_DEFAULT,
  ALERT_COUNT_MAX,
  ALERT_COUNT_MIN,
  BATTERY_DEFAULT,
  BATTERY_MAX,
  BATTERY_MIN,
  HUMIDITY_MAX,
  HUMIDITY_MIN,
  SENSOR_ALERT_DIRECTIONS,
  SENSOR_ALERT_KINDS,
  type SensorAlertRuleDto,
  SILENCE_HOURS_DEFAULT,
  SILENCE_HOURS_MAX,
  SILENCE_HOURS_MIN,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
} from '~/lib/sensor/alerts'
import type { SensorAlertDomainErrorCode } from '~/lib/services/sensorAlert'
import { m } from '~/paraglide/messages'
import {
  alertCountHint,
  alertDirectionLabel,
  alertKindLabel,
  formatAlertInput,
  formatAlertNumber,
} from './alertRuleCopy'

/** Every field is the text as typed; the schema parses it ("4,5") the way the procedure checks it. */
type FormValues = {
  kind: string
  direction: string
  threshold: string
  count: string
  silenceHours: string
}
type LimitField = 'direction' | 'threshold' | 'count' | 'silenceHours'
const LIMIT_FIELDS: ReadonlySet<string> = new Set<LimitField>([
  'direction',
  'threshold',
  'count',
  'silenceHours',
])

/** A kind's starting limit: battery 20 %, nothing for temperature and humidity (the owner's call). */
const defaultThreshold = (kind: string) => (kind === 'battery' ? String(BATTERY_DEFAULT) : '')

/** The procedure's input from the typed text; a field that doesn't parse is missing. */
function toInput(value: FormValues, deviceId: string) {
  const num = (s: string) => parseDecimal(s) ?? undefined
  switch (value.kind) {
    case 'silence':
      return { kind: value.kind, deviceId, silenceHours: num(value.silenceHours) }
    case 'battery':
      return {
        kind: value.kind,
        deviceId,
        threshold: num(value.threshold),
        count: num(value.count),
      }
    default:
      return {
        kind: value.kind,
        deviceId,
        direction: value.direction,
        threshold: num(value.threshold),
        count: num(value.count),
      }
  }
}

/** The bounds a field breaks, in words (built per call: the current locale). */
function fieldError(field: LimitField, kind: string): string {
  const whole = (min: number, max: number) =>
    m.sensors_alert_error_whole({ min: String(min), max: String(max) })
  const percent = (min: number, max: number) =>
    m.sensors_alert_error_percent({ min: String(min), max: String(max) })
  switch (field) {
    case 'direction':
      return m.sensors_alert_error_direction()
    case 'count':
      return whole(ALERT_COUNT_MIN, ALERT_COUNT_MAX)
    case 'silenceHours':
      return whole(SILENCE_HOURS_MIN, SILENCE_HOURS_MAX)
    case 'threshold':
      if (kind === 'humidity') return percent(HUMIDITY_MIN, HUMIDITY_MAX)
      if (kind === 'battery') return percent(BATTERY_MIN, BATTERY_MAX)
      return m.sensors_alert_error_temperature({
        min: formatAlertNumber(TEMPERATURE_MIN),
        max: formatAlertNumber(TEMPERATURE_MAX),
      })
  }
}

// The form checks the very schema the procedure takes (`sensorAlertRuleInput`), so the two can't
// disagree; its issues land on the field they name, in our words.
function makeFormSchema(deviceId: string) {
  return z
    .object({
      kind: z.string(),
      direction: z.string(),
      threshold: z.string(),
      count: z.string(),
      silenceHours: z.string(),
    })
    .superRefine((value, ctx) => {
      const result = sensorAlertRuleInput.safeParse(toInput(value, deviceId))
      if (result.success) return
      const fields = new Set(result.error.issues.map((issue) => String(issue.path[0])))
      for (const field of fields) {
        if (!LIMIT_FIELDS.has(field)) continue
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: fieldError(field as LimitField, value.kind),
        })
      }
    })
}

function defaults(rule: SensorAlertRuleDto | undefined): FormValues {
  return {
    kind: rule?.kind ?? 'temperature',
    direction: rule?.direction ?? 'below',
    threshold:
      rule?.threshold != null ? formatAlertInput(rule.threshold) : defaultThreshold('temperature'),
    count: String(rule?.count ?? ALERT_COUNT_DEFAULT),
    silenceHours: String(rule?.silenceHours ?? SILENCE_HOURS_DEFAULT),
  }
}

/** A count the hint can speak for: a whole number within the bounds. */
function validCount(text: string): number | null {
  const n = parseDecimal(text)
  return n !== null && Number.isInteger(n) && n >= ALERT_COUNT_MIN && n <= ALERT_COUNT_MAX
    ? n
    : null
}

type Props = {
  device: { id: string; displayName: string }
  /** Editing this rule; absent for a new one. */
  rule: SensorAlertRuleDto | undefined
  /** The sensor's typical gap between merged readings (minutes), for the "I rad" hint. */
  gapMinutes: number | null
  /** Back to the list (Tillbaka, or after a save or delete). */
  onBack: () => void
}

// Create, edit or delete one of the viewer's own alert rules (ADR-0028, ADR-0005). Stays open
// until a save succeeds; a server error toasts. A rule that is gone returns to the list.
export function SensorAlertRuleForm({ device, rule, gapMinutes, onBack }: Props) {
  const queryClient = useQueryClient()
  const formSchema = useMemo(() => makeFormSchema(device.id), [device.id])
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const wasConfirming = useRef(false)
  // "Avbryt" on the question puts focus back on "Ta bort" (the button it replaced).
  useEffect(() => {
    if (wasConfirming.current && !confirmingDelete) deleteButton.current?.focus()
    wasConfirming.current = confirmingDelete
  }, [confirmingDelete])

  const reportError = (code: SensorAlertDomainErrorCode | undefined, fallback: string) => {
    toast.error(code ? sensorAlertErrorMessage(code) : fallback)
    // Gone (deleted in another tab): nothing left to edit.
    if (code === 'RULE_NOT_FOUND') onBack()
  }
  // The bells and the list read this one query.
  const onSettled = () => queryClient.invalidateQueries({ queryKey: orpc.sensor.alerts.key() })
  const create = useMutation(
    orpc.sensor.alerts.create.mutationOptions({
      onError: (err) =>
        reportError(isDefinedError(err) ? err.code : undefined, m.sensors_alert_save_error()),
      onSettled,
    }),
  )
  const update = useMutation(
    orpc.sensor.alerts.update.mutationOptions({
      onError: (err) =>
        reportError(isDefinedError(err) ? err.code : undefined, m.sensors_alert_save_error()),
      onSettled,
    }),
  )
  const remove = useMutation(
    orpc.sensor.alerts.delete.mutationOptions({
      onError: (err) =>
        reportError(isDefinedError(err) ? err.code : undefined, m.sensors_alert_delete_error()),
      onSettled,
    }),
  )

  const form = useAppForm({
    defaultValues: defaults(rule),
    validators: { onSubmit: formSchema },
    onSubmit: async ({ value }) => {
      const input = sensorAlertRuleInput.parse(toInput(value, device.id))
      try {
        if (rule) await update.mutateAsync({ ...input, id: rule.id })
        else await create.mutateAsync(input)
      } catch {
        return // reported by onError
      }
      toast.success(m.sensors_alert_saved())
      onBack()
    },
  })
  const kind = useStore(form.store, (s) => s.values.kind)

  async function deleteRule(id: string) {
    try {
      await remove.mutateAsync({ id })
    } catch {
      return // reported by onError
    }
    toast.success(m.sensors_alert_deleted())
    onBack()
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
    >
      <div className="flex flex-col gap-5">
        <form.AppField
          name="kind"
          // A new kind keeps the count; the limit starts over at that kind's default.
          listeners={{
            onChange: ({ value }) => form.setFieldValue('threshold', defaultThreshold(value)),
          }}
          children={(field) => (
            <field.ToggleField
              label={m.sensors_alert_field_kind()}
              options={SENSOR_ALERT_KINDS.map((k) => ({ value: k, label: alertKindLabel(k) }))}
              // Four long labels don't fit one row on a phone.
              className="grid grid-cols-2 sm:flex"
            />
          )}
        />

        {kind === 'temperature' || kind === 'humidity' ? (
          <form.AppField
            name="direction"
            children={(field) => (
              <field.ToggleField
                label={m.sensors_alert_field_direction()}
                options={SENSOR_ALERT_DIRECTIONS.map((d) => ({
                  value: d,
                  label: alertDirectionLabel(d),
                }))}
              />
            )}
          />
        ) : null}

        {kind === 'silence' ? (
          <form.AppField
            name="silenceHours"
            children={(field) => (
              <field.NumberField label={m.sensors_alert_field_silence_hours()} />
            )}
          />
        ) : (
          <>
            <form.AppField
              name="threshold"
              children={(field) => (
                <field.NumberField
                  label={m.sensors_alert_field_threshold()}
                  suffix={kind === 'temperature' ? '°C' : '%'}
                />
              )}
            />
            <form.AppField
              name="count"
              children={(field) => {
                const count = validCount(field.state.value)
                const hint =
                  count === null ? null : alertCountHint(count, gapMinutes, device.displayName)
                return (
                  <field.NumberField
                    label={m.sensors_alert_field_count()}
                    suffix={m.sensors_alert_count_suffix()}
                    description={hint ?? undefined}
                  />
                )
              }}
            />
          </>
        )}
      </div>

      <ResponsiveDialogFooter className="mt-6">
        {confirmingDelete && rule ? (
          <>
            <p className="self-center font-medium text-sm sm:mr-auto">
              {m.sensors_alert_delete_confirm()}
            </p>
            <Button
              type="button"
              variant="outline"
              autoFocus
              disabled={remove.isPending}
              onClick={() => setConfirmingDelete(false)}
            >
              {m.common_cancel()}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => deleteRule(rule.id)}
            >
              {m.sensors_alert_delete()}
            </Button>
          </>
        ) : (
          <form.AppForm>
            {rule ? (
              <Button
                ref={deleteButton}
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive sm:mr-auto"
                onClick={() => setConfirmingDelete(true)}
              >
                {m.sensors_alert_delete()}
              </Button>
            ) : null}
            <form.CancelButton onClick={onBack}>{m.common_back()}</form.CancelButton>
            <form.SubmitButton label={m.common_save()} />
          </form.AppForm>
        )}
      </ResponsiveDialogFooter>
    </form>
  )
}
