import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef } from 'react'
import { toast } from 'sonner'
import { Field, FieldError, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '~/components/ui/responsive-dialog'
import { useAppForm, useStore } from '~/hooks/form'
import type { SkodaParseResult } from '~/lib/evCharging/skodaExport'
import { MAX_IMPORT_ROWS } from '~/lib/evCharging/vehicle'
import { logger } from '~/lib/logger/browser'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatDate } from './format'

// What the file picker left in the form: the parser's verdict, or why it never
// got that far (unreadable file / more rows than the server accepts).
type Picked = SkodaParseResult | { ok: false; error: 'read_failed' | 'too_many' | 'reading' }

// A 5 000-row export is a few hundred kB; anything this large is not one, and
// reading it would block the main thread.
const MAX_FILE_BYTES = 5 * 1024 * 1024

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Import the car's MySkoda charging log (ADR-0021). The CSV is parsed in the
// browser and only the parsed rows (no location or price text) are sent. The
// dialog stays open on failure so the import can be retried.
export function VehicleImportDialog({ open, onOpenChange }: Props) {
  // True while an import request is in flight: Esc, the overlay and Cancel must
  // not close the dialog on top of it (the outcome would be invisible).
  const busy = useRef(false)
  const guarded = (o: boolean) => {
    if (!o && busy.current) return
    onOpenChange(o)
  }
  return (
    <ResponsiveDialog open={open} onOpenChange={guarded}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{m.charging_vehicle_import_title()}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {m.charging_vehicle_import_description()}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {/* Mounted only while open (Radix unmounts closed content), so the form resets per open. */}
        <ImportForm
          busy={busy}
          onDone={() => onOpenChange(false)}
          onCancel={() => guarded(false)}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

const STATUS_ID = 'vehicleExport-status'

function pickedError(picked: Picked & { ok: false }): string {
  switch (picked.error) {
    case 'not_skoda_export':
      return m.charging_vehicle_import_wrong_file()
    case 'empty':
      return m.charging_vehicle_import_empty()
    case 'too_many':
      return m.charging_vehicle_import_too_many({ max: MAX_IMPORT_ROWS })
    case 'reading':
      return m.charging_vehicle_import_reading()
    case 'read_failed':
      return m.charging_vehicle_import_read_error()
  }
}

async function readPicked(file: File): Promise<Picked> {
  if (file.size > MAX_FILE_BYTES) return { ok: false, error: 'too_many' }
  try {
    // Lazy: papaparse only loads when an admin actually picks a file.
    const { parseSkodaExport } = await import('~/lib/evCharging/skodaExport')
    const parsed = parseSkodaExport(await file.text())
    return parsed.ok && parsed.rows.length > MAX_IMPORT_ROWS
      ? { ok: false, error: 'too_many' }
      : parsed
  } catch (error) {
    logger.warn('vehicle export could not be read', { error })
    return { ok: false, error: 'read_failed' }
  }
}

function ImportForm({
  busy,
  onDone,
  onCancel,
}: {
  busy: { current: boolean }
  onDone: () => void
  onCancel: () => void
}) {
  // Each pick gets a number; a parse that finishes after a newer pick is ignored.
  const pick = useRef(0)
  const queryClient = useQueryClient()
  const importRecords = useMutation(
    orpc.evCharging.importVehicleRecords.mutationOptions({
      // The attribution changes every charging figure, not just the log card.
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.evCharging.key() }),
    }),
  )

  const form = useAppForm({
    defaultValues: { parsed: null as Picked | null },
    validators: { onSubmit: ({ value }) => (value.parsed?.ok ? undefined : 'invalid') },
    onSubmit: async ({ value }) => {
      if (!value.parsed?.ok) return
      busy.current = true
      let result: { ours: number; other: number }
      try {
        // Only the parsed rows leave the browser: never the file or location text.
        result = await importRecords.mutateAsync({ rows: value.parsed.rows })
      } catch {
        toast.error(m.charging_vehicle_import_error())
        return
      } finally {
        busy.current = false
      }
      // Counts every session the log decided, so a re-import still reads as an outcome.
      toast.success(m.charging_vehicle_import_done({ ours: result.ours, other: result.other }))
      onDone()
    },
  })
  const attempts = useStore(form.store, (s) => s.submissionAttempts)

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
    >
      <form.Field
        name="parsed"
        children={(field) => {
          const picked = field.state.value
          const failed = picked !== null && !picked.ok && picked.error !== 'reading'
          return (
            <Field data-invalid={failed}>
              <FieldLabel htmlFor="vehicleExport">{m.charging_vehicle_import_file()}</FieldLabel>
              <Input
                id="vehicleExport"
                name="vehicleExport"
                type="file"
                accept=".csv,text/csv"
                // Not `disabled` while submitting: that would drop the focus it holds.
                aria-disabled={form.state.isSubmitting}
                aria-invalid={failed}
                aria-describedby={STATUS_ID}
                onChange={async (e) => {
                  // The picked file is already captured by a running submit.
                  if (busy.current) return
                  const file = e.target.files?.[0]
                  const mine = ++pick.current
                  // Cleared at once: the previous file's preview must not linger,
                  // nor be submittable, while the new one is read.
                  field.handleChange(file ? { ok: false, error: 'reading' } : null)
                  if (!file) return
                  const result = await readPicked(file)
                  if (mine === pick.current) field.handleChange(result)
                }}
              />
              <div id={STATUS_ID} role="status" className="flex flex-col gap-1">
                {picked?.ok ? (
                  <>
                    <p className="text-sm">
                      {m.charging_vehicle_import_preview({
                        count: picked.rows.length,
                        from: formatDate(picked.from),
                        to: formatDate(picked.to),
                        public: picked.publicCount,
                      })}
                    </p>
                    {picked.dropped > 0 ? (
                      <p className="text-muted-foreground text-sm">
                        {m.charging_vehicle_import_dropped({ count: picked.dropped })}
                      </p>
                    ) : null}
                  </>
                ) : picked?.error === 'reading' ? (
                  <p className="text-muted-foreground text-sm">{pickedError(picked)}</p>
                ) : null}
              </div>
              {failed && picked ? <FieldError>{pickedError(picked)}</FieldError> : null}
              {picked === null && attempts > 0 ? (
                <FieldError>{m.charging_vehicle_import_choose()}</FieldError>
              ) : null}
            </Field>
          )
        }}
      />

      <ResponsiveDialogFooter className="mt-6">
        <form.AppForm>
          <form.CancelButton onClick={onCancel}>{m.common_cancel()}</form.CancelButton>
          <form.SubmitButton label={m.charging_vehicle_import_button()} />
        </form.AppForm>
      </ResponsiveDialogFooter>
    </form>
  )
}
