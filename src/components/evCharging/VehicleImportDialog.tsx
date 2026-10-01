import { useMutation, useQueryClient } from '@tanstack/react-query'
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
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatCount, formatDate } from './format'

// What the file picker left in the form: the parser's verdict, or why it never
// got that far (unreadable file / more rows than the server accepts).
type Picked = SkodaParseResult | { ok: false; error: 'read_failed' | 'too_many' }

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Import the car's MySkoda charging log (ADR-0021). The CSV is parsed in the
// browser and only the parsed rows (no location or price text) are sent. The
// dialog stays open on failure so the import can be retried.
export function VehicleImportDialog({ open, onOpenChange }: Props) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{m.charging_vehicle_import_title()}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {m.charging_vehicle_import_description()}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {/* Mounted only while open (Radix unmounts closed content), so the form resets per open. */}
        <ImportForm onDone={() => onOpenChange(false)} />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function pickedError(picked: Picked & { ok: false }): string {
  switch (picked.error) {
    case 'not_skoda_export':
      return m.charging_vehicle_import_wrong_file()
    case 'empty':
      return m.charging_vehicle_import_empty()
    case 'too_many':
      return m.charging_vehicle_import_too_many({ max: MAX_IMPORT_ROWS })
    case 'read_failed':
      return m.charging_vehicle_import_read_error()
  }
}

async function readPicked(file: File): Promise<Picked> {
  try {
    // Lazy: papaparse only loads when an admin actually picks a file.
    const { parseSkodaExport } = await import('~/lib/evCharging/skodaExport')
    const parsed = parseSkodaExport(await file.text())
    return parsed.ok && parsed.rows.length > MAX_IMPORT_ROWS
      ? { ok: false, error: 'too_many' }
      : parsed
  } catch {
    return { ok: false, error: 'read_failed' }
  }
}

function ImportForm({ onDone }: { onDone: () => void }) {
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
      try {
        // Only the parsed rows leave the browser: never the file or location text.
        const { ours, other } = await importRecords.mutateAsync({ rows: value.parsed.rows })
        // Counts every session the log decided, so a re-import still reads as an outcome.
        toast.success(m.charging_vehicle_import_done({ ours, other }))
        onDone()
      } catch {
        toast.error(m.charging_vehicle_import_error())
      }
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
          return (
            <Field data-invalid={picked !== null && !picked.ok}>
              <FieldLabel htmlFor="vehicleExport">{m.charging_vehicle_import_file()}</FieldLabel>
              <Input
                id="vehicleExport"
                name="vehicleExport"
                type="file"
                accept=".csv,text/csv"
                disabled={form.state.isSubmitting}
                aria-invalid={picked !== null && !picked.ok}
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  field.handleChange(file ? await readPicked(file) : null)
                }}
              />
              {picked?.ok ? (
                <>
                  <p className="text-sm">
                    {m.charging_vehicle_import_preview({
                      count: formatCount(picked.rows.length),
                      from: formatDate(picked.from),
                      to: formatDate(picked.to),
                      public: formatCount(picked.publicCount),
                    })}
                  </p>
                  {picked.dropped > 0 ? (
                    <p className="text-muted-foreground text-sm">
                      {m.charging_vehicle_import_dropped({ count: picked.dropped })}
                    </p>
                  ) : null}
                </>
              ) : picked ? (
                <FieldError>{pickedError(picked)}</FieldError>
              ) : attempts > 0 ? (
                <FieldError>{m.charging_vehicle_import_choose()}</FieldError>
              ) : null}
            </Field>
          )
        }}
      />

      <ResponsiveDialogFooter className="mt-6">
        <form.AppForm>
          <form.CancelButton onClick={onDone}>{m.common_cancel()}</form.CancelButton>
          <form.SubmitButton label={m.charging_vehicle_import_button()} />
        </form.AppForm>
      </ResponsiveDialogFooter>
    </form>
  )
}
