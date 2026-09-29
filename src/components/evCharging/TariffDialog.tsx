import { isDefinedError } from '@orpc/client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
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
import { TARIFF_LIMITS, type TariffAmountField } from '~/lib/evCharging/tariff'
import { orpc, type RouterOutputs } from '~/lib/orpc/client'
import { tariffErrorMessage } from '~/lib/orpc/tariffErrorMessage'
import { parseDecimal } from '~/lib/parseDecimal'
import { stockholmDayOf } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'
import { formatDecimal, formatDecimalInput } from './format'

export type Tariff = RouterOutputs['tariff']['list'][number]

/** New (optionally pre-filled from an existing period) or editing one. */
export type TariffDialogMode = { kind: 'new'; from?: Tariff } | { kind: 'edit'; tariff: Tariff }

// A decimal typed as text ("5,331"), within the field's allowed range —
// mirrors the procedure input and the service's check-first rule.
const amountField = (field: TariffAmountField) => {
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
}

const formSchema = z.object({
  validFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: m.charging_tariff_error_date_required() }),
  retailMarkupOre: amountField('retailMarkupOre'),
  gridTransferOre: amountField('gridTransferOre'),
  energyTaxOre: amountField('energyTaxOre'),
  vatPercent: amountField('vatPercent'),
})

type Props = {
  open: boolean
  mode: TariffDialogMode | undefined
  onOpenChange: (open: boolean) => void
}

// Create or edit a tariff period (ADR-0013 URL-state dialog). Unlike the
// instant-close dialogs, it stays open until the save succeeds: a period that
// collides with an existing start date is a likely, correctable mistake.
export function TariffDialog({ open, mode, onOpenChange }: Props) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {mode?.kind === 'edit'
              ? m.charging_tariff_dialog_edit_title()
              : m.charging_tariff_dialog_new_title()}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {m.charging_tariff_dialog_description()}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {mode ? (
          // key re-inits the form when another period (or "new") is opened.
          <TariffForm
            key={mode.kind === 'edit' ? mode.tariff.id : 'new'}
            mode={mode}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function defaults(mode: TariffDialogMode) {
  const source = mode.kind === 'edit' ? mode.tariff : mode.from
  return {
    // A new period starts today (Stockholm) unless the admin changes it.
    validFrom: mode.kind === 'edit' ? mode.tariff.validFrom : stockholmDayOf(Date.now()),
    retailMarkupOre: source ? formatDecimalInput(source.retailMarkupOre) : '',
    gridTransferOre: source ? formatDecimalInput(source.gridTransferOre) : '',
    energyTaxOre: source ? formatDecimalInput(source.energyTaxOre) : '',
    vatPercent: formatDecimalInput(source?.vatPercent ?? 25),
  }
}

function TariffForm({ mode, onDone }: { mode: TariffDialogMode; onDone: () => void }) {
  const queryClient = useQueryClient()
  // A tariff change re-prices history: refresh the tariff list and every
  // charging query (the cost figures live there).
  const onSettled = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.tariff.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.evCharging.key() }),
    ])
  const create = useMutation(
    orpc.tariff.create.mutationOptions({
      onError: (err) =>
        toast.error(
          isDefinedError(err) ? tariffErrorMessage(err.code) : m.charging_tariff_save_error(),
        ),
      onSettled,
    }),
  )
  const update = useMutation(
    orpc.tariff.update.mutationOptions({
      onError: (err) =>
        toast.error(
          isDefinedError(err) ? tariffErrorMessage(err.code) : m.charging_tariff_save_error(),
        ),
      onSettled,
    }),
  )

  const form = useAppForm({
    defaultValues: defaults(mode),
    validators: { onSubmit: formSchema },
    onSubmit: async ({ value }) => {
      const input = {
        validFrom: value.validFrom,
        retailMarkupOre: parseDecimal(value.retailMarkupOre) ?? 0,
        gridTransferOre: parseDecimal(value.gridTransferOre) ?? 0,
        energyTaxOre: parseDecimal(value.energyTaxOre) ?? 0,
        vatPercent: parseDecimal(value.vatPercent) ?? 0,
      }
      try {
        if (mode.kind === 'edit') await update.mutateAsync({ id: mode.tariff.id, ...input })
        else await create.mutateAsync(input)
      } catch {
        return // onError toasted; keep the dialog open to fix the input
      }
      toast.success(m.charging_tariff_saved())
      onDone()
    },
  })

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
          children={(field) => (
            <field.DateField label={m.charging_tariff_field_valid_from()} autoFocus />
          )}
        />
        <form.AppField
          name="retailMarkupOre"
          children={(field) => (
            <field.NumberField
              label={m.charging_tariff_field_markup()}
              description={m.charging_tariff_field_markup_hint()}
              suffix={ore}
            />
          )}
        />
        <form.AppField
          name="gridTransferOre"
          children={(field) => (
            <field.NumberField label={m.charging_tariff_field_grid()} suffix={ore} />
          )}
        />
        <form.AppField
          name="energyTaxOre"
          children={(field) => (
            <field.NumberField label={m.charging_tariff_field_tax()} suffix={ore} />
          )}
        />
        <form.AppField
          name="vatPercent"
          children={(field) => (
            <field.NumberField label={m.charging_tariff_field_vat()} suffix="%" />
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
