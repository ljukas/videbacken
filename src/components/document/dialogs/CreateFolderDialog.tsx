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
import { folderErrorMessage } from '~/lib/orpc/folderErrorMessage'
import { m } from '~/paraglide/messages'

const schema = z.object({
  name: z
    .string()
    .min(1, { error: () => m.validation_name_required() })
    .max(255),
})

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  parentId: string | null
}

export function CreateFolderDialog({ open, onOpenChange, parentId }: Props) {
  const queryClient = useQueryClient()

  const createMutation = useMutation(
    orpc.folder.createFolder.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: orpc.folder.key() })
        toast.success(m.folder_created_toast())
        onOpenChange(false)
      },
      onError: (err) =>
        toast.error(isDefinedError(err) ? folderErrorMessage(err.code) : m.folder_create_error()),
    }),
  )

  const form = useAppForm({
    defaultValues: { name: '' },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      await createMutation.mutateAsync({ parentId, name: value.name })
    },
  })

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{m.folder_create_title()}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>{m.folder_create_description()}</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            form.handleSubmit()
          }}
        >
          <form.AppField name="name">
            {(field) => (
              <field.TextField label={m.document_name_label()} autoComplete="off" autoFocus />
            )}
          </form.AppField>

          <ResponsiveDialogFooter className="mt-6">
            <form.AppForm>
              <form.CancelButton onClick={() => onOpenChange(false)}>
                {m.common_cancel()}
              </form.CancelButton>
              <form.SubmitButton label={m.folder_create_submit()} />
            </form.AppForm>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
