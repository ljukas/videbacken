import { isDefinedError } from '@orpc/client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Label } from '~/components/ui/label'
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '~/components/ui/responsive-dialog'
import { useAppForm, useStore } from '~/hooks/form'
import { orpc } from '~/lib/orpc/client'
import { sensorErrorMessage } from '~/lib/orpc/sensorErrorMessage'
import { fallbackSensorName, formatMac } from '~/lib/sensor/deviceName'
import { m } from '~/paraglide/messages'

export type EditableDevice = {
  id: string
  name: string | null
  location: string | null
  mac: string
  shellyName: string | null
}

// The name input keeps its default id (the field name); the row header labels it.
const NAME_INPUT_ID = 'name'
const NAME_LABEL_ID = 'sensor-name-label'
const NAME_BADGE_ID = 'sensor-name-badge'
const IDENTITY_HEADING_ID = 'sensor-identity-heading'

// Mirrors the server-side `labelField` bounds so the form can't submit a value
// the procedure would reject. Blank is allowed — it clears the label server-side.
const formSchema = z.object({
  name: z.string().trim().max(80),
  location: z.string().trim().max(120),
})

type Props = {
  open: boolean
  device: EditableDevice | undefined
  onOpenChange: (open: boolean) => void
}

export function EditDeviceDialog({ open, device, onOpenChange }: Props) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{m.sensors_edit_device()}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>{m.sensors_edit_description()}</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {device ? (
          // key re-inits the form when a different device is opened.
          <EditDeviceForm key={device.id} device={device} onDone={() => onOpenChange(false)} />
        ) : null}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function EditDeviceForm({ device, onDone }: { device: EditableDevice; onDone: () => void }) {
  const queryClient = useQueryClient()
  const rename = useMutation(
    orpc.sensor.renameDevice.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.sensor.key() })
        toast.success(m.sensors_saved())
      },
      onError: (err) => {
        toast.error(isDefinedError(err) ? sensorErrorMessage(err.code) : m.sensors_save_error())
      },
    }),
  )

  const form = useAppForm({
    defaultValues: { name: device.name ?? '', location: device.location ?? '' },
    validators: { onSubmit: formSchema },
    onSubmit: ({ value }) => {
      // Instant close; the toast + query invalidation reconcile in the
      // background (same pattern as EditUserDialog).
      rename.mutate({ id: device.id, name: value.name, location: value.location })
      onDone()
    },
  })

  // What the page will show for the name as typed: blank (spaces too — the
  // server clears them) falls back to the Shelly name, else "Sensor a1b2".
  const name = useStore(form.store, (s) => s.values.name)
  const hasOwnName = name.trim() !== ''
  const fallback = fallbackSensorName(device.shellyName, device.mac)
  const badge = hasOwnName
    ? m.sensors_name_badge_own()
    : device.shellyName
      ? m.sensors_name_badge_shelly()
      : m.sensors_name_badge_default()

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
    >
      <div className="flex flex-col gap-5">
        <DeviceIdentity device={device} />

        {/* The row header names the input and says where the shown name comes
            from (CredentialFieldRow's shape): the badge is real text, never
            colour alone, and is announced with the input. */}
        <div className="flex flex-col gap-2">
          <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
            <Label id={NAME_LABEL_ID} htmlFor={NAME_INPUT_ID}>
              {m.sensors_field_name()}
            </Label>
            <Badge id={NAME_BADGE_ID} variant="outline" className="text-muted-foreground">
              {badge}
            </Badge>
            {hasOwnName ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                // 44 px on touch without growing the header: the extra height overlaps the gap.
                className="pointer-coarse:-my-2 ml-auto h-7 pointer-coarse:h-11 px-1"
                aria-label={m.sensors_name_reset_label()}
                onClick={() => {
                  form.setFieldValue('name', '')
                  // The button unmounts with the text; focus stays in the form.
                  document.getElementById(NAME_INPUT_ID)?.focus()
                }}
              >
                {m.sensors_name_reset()}
              </Button>
            ) : null}
          </div>
          <form.AppField
            name="name"
            children={(field) => (
              <field.TextField
                labelledBy={NAME_LABEL_ID}
                describedBy={NAME_BADGE_ID}
                placeholder={fallback}
                description={m.sensors_name_hint({ fallback })}
                autoFocus
              />
            )}
          />
        </div>

        <form.AppField
          name="location"
          children={(field) => <field.TextField label={m.sensors_field_location()} />}
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

// Which physical device this is, as the Shelly app names it: its app name and
// its MAC (the app's device information). Read-only.
function DeviceIdentity({ device }: { device: EditableDevice }) {
  return (
    <section aria-labelledby={IDENTITY_HEADING_ID} className="rounded-lg border p-3 text-sm">
      <h3 id={IDENTITY_HEADING_ID} className="font-medium font-sans text-sm tracking-normal">
        {m.sensors_identity_heading()}
      </h3>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">{m.sensors_identity_shelly_name()}</dt>
        <dd className="break-words">
          {device.shellyName ?? m.sensors_identity_shelly_name_missing()}
        </dd>
        <dt className="text-muted-foreground">{m.sensors_identity_mac()}</dt>
        <dd className="font-mono tabular-nums">{formatMac(device.mac)}</dd>
      </dl>
      {device.shellyName ? null : (
        <p className="mt-2 text-muted-foreground">{m.sensors_identity_shelly_name_hint()}</p>
      )}
    </section>
  )
}
