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
import type { AdminShareRow } from '~/lib/orpc/procedures/share'
import { m } from '~/paraglide/messages'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  share: AdminShareRow | undefined
}

function todayUtc(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
}

const schema = z.object({
  on: z.date(),
})

export function UnassignShareDialog({ open, onOpenChange, share }: Props) {
  if (!share) return null
  return (
    <UnassignShareDialogBody
      key={share.shareCode}
      open={open}
      onOpenChange={onOpenChange}
      share={share}
    />
  )
}

function UnassignShareDialogBody({
  open,
  onOpenChange,
  share,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  share: AdminShareRow
}) {
  const queryClient = useQueryClient()

  const unassignMutation = useMutation(
    orpc.share.unassign.mutationOptions({
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.share.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.user.listContacts.key() }),
        ])
        toast.success(m.share_unassigned())
        onOpenChange(false)
      },
      onError: (err) => {
        toast.error(err.message || m.share_unassign_error())
      },
    }),
  )

  const form = useAppForm({
    defaultValues: { on: todayUtc() },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      await unassignMutation.mutateAsync({
        shareCode: share.shareCode,
        on: value.on,
      })
    },
  })

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {m.share_unassign_title({ code: share.shareCode })}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {m.share_unassign_description()}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            form.handleSubmit()
          }}
          className="flex flex-col gap-4"
        >
          <form.AppField
            name="on"
            children={(field) => <field.DateField label={m.share_field_from()} />}
          />
          <ResponsiveDialogFooter className="mt-2">
            <form.AppForm>
              <form.CancelButton onClick={() => onOpenChange(false)}>
                {m.common_cancel()}
              </form.CancelButton>
              <form.SubmitButton
                label={m.share_unassign_submit()}
                pendingLabel={m.share_unassign_pending()}
              />
            </form.AppForm>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
