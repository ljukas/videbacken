import { isDefinedError } from '@orpc/client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { TextareaField } from '~/components/form/TextareaField'
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '~/components/ui/responsive-dialog'
import { useAppForm } from '~/hooks/form'
import {
  HEAT_PUMP_EVENT_KINDS,
  HEAT_PUMP_EVENT_NOTE_MAX,
  type HeatPumpEventDto,
  type HeatPumpEventKind,
  isHeatPumpEventKind,
  normalizeNote,
  noteLength,
} from '~/lib/heatPump/events'
import { orpc } from '~/lib/orpc/client'
import { heatPumpEventErrorMessage } from '~/lib/orpc/heatPumpEventErrorMessage'
import type { HeatPumpEventErrorCode } from '~/lib/services/heatPump'
import { isStockholmDay, stockholmDayOf } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'
import { eventKindLabel, eventUnitLabel, type HeatPumpUnitRef } from './eventCopy'

/** New, or editing one event. */
export type HeatPumpEventDialogMode = { kind: 'new' } | { kind: 'edit'; event: HeatPumpEventDto }

const modeKey = (mode: HeatPumpEventDialogMode) => (mode.kind === 'edit' ? mode.event.id : 'new')
/** The unit select's value for "every unit": a Radix Select item can't have an empty value. */
const ALL_UNITS = 'all'
const MAX = String(HEAT_PUMP_EVENT_NOTE_MAX)

// Built per form (not at module load) so the messages are in the current locale and "today"
// is the day the form opened (Stockholm, as the service checks it).
function makeFormSchema(today: string) {
  return z.object({
    occurredOn: z
      .string()
      .refine(isStockholmDay, { message: m.heat_pump_event_error_date_required() })
      .refine((day) => !isStockholmDay(day) || day <= today, {
        message: m.heat_pump_event_error_future(),
      }),
    unit: z.string(),
    // A string refined (not z.enum): the schema's input type must match the form's string value.
    kind: z.string().refine(isHeatPumpEventKind),
    note: z.string().refine((s) => noteLength(s.trim()) <= HEAT_PUMP_EVENT_NOTE_MAX, {
      message: m.heat_pump_event_error_note_too_long({ max: MAX }),
    }),
  })
}

type Props = {
  open: boolean
  mode: HeatPumpEventDialogMode | undefined
  /** Name order; the unit select lists "Båda" / "Alla" first, then these. */
  units: readonly HeatPumpUnitRef[]
  onOpenChange: (open: boolean) => void
}

// Log or edit an event (ADR-0013 URL-state dialog, ADR-0005 form). Stays open until the save
// succeeds; a server error toasts. An event another admin deleted closes it.
export function HeatPumpEventDialog({ open, mode, units, onOpenChange }: Props) {
  // Keep the last mode while the close animation runs (the URL — and so `mode` — clears first).
  const [shown, setShown] = useState(mode)
  if (mode && (!shown || modeKey(mode) !== modeKey(shown))) setShown(mode)
  const current = mode ?? shown
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {current?.kind === 'edit'
              ? m.heat_pump_event_dialog_edit_title()
              : m.heat_pump_event_dialog_new_title()}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {m.heat_pump_event_dialog_description()}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {current ? (
          // key re-inits the form when another event (or "new") is opened.
          <EventForm
            key={modeKey(current)}
            mode={current}
            units={units}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function defaults(mode: HeatPumpEventDialogMode, today: string) {
  if (mode.kind === 'edit') {
    const e = mode.event
    return {
      occurredOn: e.occurredOn,
      unit: e.heatPumpId ?? ALL_UNITS,
      kind: e.kind as string,
      note: e.note ?? '',
    }
  }
  return { occurredOn: today, unit: ALL_UNITS, kind: 'service' as string, note: '' }
}

function EventForm({
  mode,
  units,
  onDone,
}: {
  mode: HeatPumpEventDialogMode
  units: readonly HeatPumpUnitRef[]
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const today = useMemo(() => stockholmDayOf(Date.now()), [])
  const formSchema = useMemo(() => makeFormSchema(today), [today])
  const reportError = (code: HeatPumpEventErrorCode | undefined) => {
    toast.error(code ? heatPumpEventErrorMessage(code) : m.heat_pump_event_save_error())
    // Gone (another admin deleted it): nothing left to edit.
    if (code === 'EVENT_NOT_FOUND') onDone()
  }
  // The list, the chart's markers and (step 4b) the signature all read this one query.
  const onSettled = () => queryClient.invalidateQueries({ queryKey: orpc.heatPump.events.key() })
  const create = useMutation(
    orpc.heatPump.events.create.mutationOptions({
      onError: (err) => reportError(isDefinedError(err) ? err.code : undefined),
      onSettled,
    }),
  )
  const update = useMutation(
    orpc.heatPump.events.update.mutationOptions({
      onError: (err) => reportError(isDefinedError(err) ? err.code : undefined),
      onSettled,
    }),
  )

  const form = useAppForm({
    defaultValues: defaults(mode, today),
    validators: { onSubmit: formSchema },
    onSubmit: async ({ value }) => {
      const input = {
        occurredOn: value.occurredOn,
        heatPumpId: value.unit === ALL_UNITS ? null : value.unit,
        kind: value.kind as HeatPumpEventKind,
        note: normalizeNote(value.note),
      }
      try {
        if (mode.kind === 'edit') await update.mutateAsync({ id: mode.event.id, ...input })
        else await create.mutateAsync(input)
      } catch {
        return // reported by onError
      }
      toast.success(m.heat_pump_event_saved())
      onDone()
    },
  })

  return (
    <form
      // The date's `max` only steers the picker: a typed future day gets the form's own message, not the browser's.
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
    >
      <div className="flex flex-col gap-5">
        <form.AppField
          name="occurredOn"
          children={(field) => (
            <field.DateField label={m.heat_pump_event_field_date()} max={today} autoFocus />
          )}
        />
        <form.AppField
          name="unit"
          children={(field) => (
            <field.SelectField
              label={m.heat_pump_event_field_unit()}
              options={[
                { value: ALL_UNITS, label: eventUnitLabel(null, units) },
                ...units.map((u) => ({ value: u.id, label: u.name })),
              ]}
            />
          )}
        />
        <form.AppField
          name="kind"
          children={(field) => (
            <field.SelectField
              label={m.heat_pump_event_field_kind()}
              options={HEAT_PUMP_EVENT_KINDS.map((k) => ({ value: k, label: eventKindLabel(k) }))}
            />
          )}
        />
        <form.AppField
          name="note"
          // The count reads the field's own value, so typing re-renders this field only; past the max it turns
          // destructive.
          children={(field) => {
            const count = noteLength(field.state.value.trim())
            return (
              <TextareaField
                label={m.heat_pump_event_field_note()}
                description={
                  <span
                    className={count > HEAT_PUMP_EVENT_NOTE_MAX ? 'text-destructive' : undefined}
                  >
                    {m.heat_pump_event_note_count({ count: String(count), max: MAX })}
                  </span>
                }
              />
            )
          }}
        />
      </div>
      <ResponsiveDialogFooter className="mt-6">
        <form.AppForm>
          <form.CancelButton onClick={onDone}>{m.common_cancel()}</form.CancelButton>
          <form.SubmitButton label={m.common_save()} />
        </form.AppForm>
      </ResponsiveDialogFooter>
    </form>
  )
}
