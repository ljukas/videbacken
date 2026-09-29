import { isDefinedError } from '@orpc/client'
import { useStore } from '@tanstack/react-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
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
  DEFAULT_VAT_PERCENT,
  statutoryEnergyTaxOre,
  TARIFF_LIMITS,
  type TariffAmountField,
} from '~/lib/evCharging/tariff'
import { orpc, type RouterOutputs } from '~/lib/orpc/client'
import { tariffErrorMessage } from '~/lib/orpc/tariffErrorMessage'
import { parseDecimal } from '~/lib/parseDecimal'
import type { TariffDomainErrorCode } from '~/lib/services/tariff'
import { stockholmDayOf } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'
import { formatDecimal, formatDecimalInput } from './format'

export type Tariff = RouterOutputs['tariff']['list'][number]

/** New (optionally pre-filled from an existing period) or editing one. */
export type TariffDialogMode = { kind: 'new'; from?: Tariff } | { kind: 'edit'; tariff: Tariff }

const modeKey = (mode: TariffDialogMode) => (mode.kind === 'edit' ? mode.tariff.id : 'new')

/** Grid transfer and energy tax are tens of öre; below 1 is almost surely kronor. */
const KRONOR_SUSPECT: ReadonlySet<TariffAmountField> = new Set(['gridTransferOre', 'energyTaxOre'])

// Built per form (not at module load) so every message is in the current
// locale. A decimal typed as text ("5,331"), within the field's allowed
// range — mirroring the procedure input and the service's check-first rule.
function makeFormSchema() {
  const amount = (field: TariffAmountField) => {
    const { min, max } = TARIFF_LIMITS[field]
    return z
      .string()
      .refine((s) => parseDecimal(s) !== null, { message: m.charging_tariff_error_not_a_number() })
      .refine(
        (s) => {
          const n = parseDecimal(s)
          return n === null || (n >= min && n <= max)
        },
        {
          message: m.charging_tariff_error_range({
            min: formatDecimal(min),
            max: formatDecimal(max),
          }),
        },
      )
      .refine(
        (s) => {
          const n = parseDecimal(s)
          // 0 is a real (if unusual) amount; 0 < n < 1 is the kronor mistake.
          return !KRONOR_SUSPECT.has(field) || n === null || n === 0 || n >= 1
        },
        { message: m.charging_tariff_error_looks_like_kronor() },
      )
  }
  return z.object({
    validFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, { message: m.charging_tariff_error_date_required() }),
    retailMarkupOre: amount('retailMarkupOre'),
    gridTransferOre: amount('gridTransferOre'),
    energyTaxOre: amount('energyTaxOre'),
    vatPercent: amount('vatPercent'),
  })
}

type Props = {
  open: boolean
  mode: TariffDialogMode | undefined
  onOpenChange: (open: boolean) => void
}

// Create or edit a tariff period (ADR-0013 URL-state dialog). Unlike the
// instant-close dialogs, it stays open until the save succeeds: a period that
// collides with an existing start date is a likely, correctable mistake.
export function TariffDialog({ open, mode, onOpenChange }: Props) {
  // Keep the last mode while the close animation runs (the URL — and so
  // `mode` — clears first), so the dialog doesn't blank as it fades out.
  const [shown, setShown] = useState(mode)
  if (mode && (!shown || modeKey(mode) !== modeKey(shown))) setShown(mode)
  const current = mode ?? shown

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {current?.kind === 'edit'
              ? m.charging_tariff_dialog_edit_title()
              : m.charging_tariff_dialog_new_title()}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {m.charging_tariff_dialog_description()}
            {current?.kind === 'edit' ? ` ${m.charging_tariff_dialog_edit_note()}` : null}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {current ? (
          // key re-inits the form when another period (or "new") is opened.
          <TariffForm key={modeKey(current)} mode={current} onDone={() => onOpenChange(false)} />
        ) : null}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function defaults(mode: TariffDialogMode) {
  if (mode.kind === 'edit') {
    const t = mode.tariff
    return {
      validFrom: t.validFrom,
      retailMarkupOre: formatDecimalInput(t.retailMarkupOre),
      gridTransferOre: formatDecimalInput(t.gridTransferOre),
      energyTaxOre: formatDecimalInput(t.energyTaxOre),
      vatPercent: formatDecimalInput(t.vatPercent),
    }
  }
  // A new period starts on the 1st of this month (Stockholm) — retail costs
  // change monthly, grid tariffs and tax on 1 January — with that year's
  // statutory energy tax.
  const validFrom = `${stockholmDayOf(Date.now()).slice(0, 8)}01`
  const from = mode.from
  const tax = statutoryEnergyTaxOre(validFrom) ?? from?.energyTaxOre
  return {
    validFrom,
    retailMarkupOre: from ? formatDecimalInput(from.retailMarkupOre) : '',
    gridTransferOre: from ? formatDecimalInput(from.gridTransferOre) : '',
    energyTaxOre: tax === undefined ? '' : formatDecimalInput(tax),
    vatPercent: formatDecimalInput(from?.vatPercent ?? DEFAULT_VAT_PERCENT),
  }
}

/** Parsed after validation passed — a null here is a schema/parser mismatch. */
function amountOf(value: string): number {
  const n = parseDecimal(value)
  if (n === null) throw new Error('Tariff form submitted an unparsed amount')
  return n
}

function TariffForm({ mode, onDone }: { mode: TariffDialogMode; onDone: () => void }) {
  const queryClient = useQueryClient()
  const formSchema = useMemo(makeFormSchema, [])
  // The start date the server said is taken. Kept as state and checked by a
  // field validator (not written into the error map, which TanStack clears on
  // every blur/change), so the error stays until the date actually changes.
  const [takenDay, setTakenDay] = useState<string | null>(null)
  // Set on that rejection; the field can only take focus once the submit has
  // ended (inputs are disabled while submitting).
  const focusDateAfterSubmit = useRef(false)

  // A taken start date is shown on the date field itself (the dialog stays
  // open so it can be fixed); any other failure is a toast.
  const reportError = (code: TariffDomainErrorCode | undefined) => {
    if (code === 'TARIFF_VALID_FROM_TAKEN') {
      setTakenDay(form.getFieldValue('validFrom'))
      form.setFieldMeta('validFrom', (meta) => ({ ...meta, isTouched: true }))
      focusDateAfterSubmit.current = true
      return
    }
    toast.error(code ? tariffErrorMessage(code) : m.charging_tariff_save_error())
  }
  // A tariff change re-prices history: refresh the tariff list and every
  // charging query (the cost figures live there).
  const onSettled = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.tariff.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.evCharging.key() }),
    ])
  const create = useMutation(
    orpc.tariff.create.mutationOptions({
      onError: (err) => reportError(isDefinedError(err) ? err.code : undefined),
      onSettled,
    }),
  )
  const update = useMutation(
    orpc.tariff.update.mutationOptions({
      onError: (err) => reportError(isDefinedError(err) ? err.code : undefined),
      onSettled,
    }),
  )

  const form = useAppForm({
    defaultValues: defaults(mode),
    validators: { onSubmit: formSchema },
    onSubmit: async ({ value }) => {
      const input = {
        validFrom: value.validFrom,
        retailMarkupOre: amountOf(value.retailMarkupOre),
        gridTransferOre: amountOf(value.gridTransferOre),
        energyTaxOre: amountOf(value.energyTaxOre),
        vatPercent: amountOf(value.vatPercent),
      }
      try {
        if (mode.kind === 'edit') await update.mutateAsync({ id: mode.tariff.id, ...input })
        else await create.mutateAsync(input)
      } catch {
        return // reported by onError; keep the dialog open to fix the input
      }
      toast.success(m.charging_tariff_saved())
      onDone()
    },
  })

  const isSubmitting = useStore(form.store, (st) => st.isSubmitting)
  const validFromValue = useStore(form.store, (st) => st.values.validFrom)
  useEffect(() => {
    // Surface the taken-date error now that the field's validator knows it…
    if (takenDay !== null) form.validateField('validFrom', 'change')
  }, [takenDay, form])
  useEffect(() => {
    // …and move focus there once the submit has finished.
    if (isSubmitting || !focusDateAfterSubmit.current) return
    focusDateAfterSubmit.current = false
    document.getElementById('validFrom')?.focus()
  }, [isSubmitting])
  const takenError = ({ value }: { value: string }) =>
    takenDay !== null && value === takenDay
      ? { message: m.charging_tariff_error_valid_from_taken() }
      : undefined
  // Only claim "pre-filled" when it was: a new period in a year the table knows.
  const taxHint =
    mode.kind === 'new' && statutoryEnergyTaxOre(validFromValue) !== undefined
      ? m.charging_tariff_field_tax_hint()
      : m.charging_tariff_field_tax_hint_plain()

  const ore = m.charging_tariff_unit_ore()
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
    >
      <div className="flex flex-col gap-5">
        <form.AppField
          name="validFrom"
          // Change-only: raised via validateField('change'), cleared by the next
          // edit; a blur never touches this slot, so the message stays put.
          validators={{ onChange: takenError }}
          listeners={{
            onChange: ({ value }) => {
              // For a new period whose tax hasn't been typed over, the tax
              // follows the chosen year's statutory rate.
              const tax = statutoryEnergyTaxOre(value)
              const taxTyped = form.getFieldMeta('energyTaxOre')?.isDirty
              if (mode.kind === 'new' && tax !== undefined && !taxTyped) {
                form.setFieldValue('energyTaxOre', formatDecimalInput(tax), {
                  dontUpdateMeta: true,
                })
              }
            },
          }}
          children={(field) => <field.DateField label={m.charging_tariff_field_valid_from()} />}
        />
        <form.AppField
          name="retailMarkupOre"
          children={(field) => (
            <field.NumberField
              label={m.charging_tariff_field_markup()}
              description={m.charging_tariff_field_markup_hint()}
              suffix={ore}
              autoFocus
            />
          )}
        />
        <form.AppField
          name="gridTransferOre"
          children={(field) => (
            <field.NumberField
              label={m.charging_tariff_field_grid()}
              description={m.charging_tariff_field_grid_hint()}
              suffix={ore}
            />
          )}
        />
        <form.AppField
          name="energyTaxOre"
          children={(field) => (
            <field.NumberField
              label={m.charging_tariff_field_tax()}
              description={taxHint}
              suffix={ore}
            />
          )}
        />
        <form.AppField
          name="vatPercent"
          children={(field) => (
            <field.NumberField
              label={m.charging_tariff_field_vat()}
              description={m.charging_tariff_field_vat_hint()}
              suffix="%"
            />
          )}
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
