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
import { orpc } from '~/lib/orpc/client'
import { sensorErrorMessage } from '~/lib/orpc/sensorErrorMessage'
import { m } from '~/paraglide/messages'

export type EditableDevice = { id: string; name: string | null; location: string | null }

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

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
    >
      <div className="flex flex-col gap-5">
        <form.AppField
          name="name"
          children={(field) => <field.TextField label={m.sensors_field_name()} autoFocus />}
        />
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
