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
import { optimisticPatch } from '~/lib/orpc/optimistic'
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
  folder: { id: string; name: string }
}

export function RenameFolderDialog({ open, onOpenChange, folder }: Props) {
  const queryClient = useQueryClient()

  const renameMutation = useMutation(
    orpc.folder.renameFolder.mutationOptions({
      // Patch the visible name into the folder tree before the round-trip. The
      // rename also rewrites this folder's `path` and its descendants' paths
      // server-side; those path-derived views reconcile on the settle refetch.
      onMutate: ({ name }) =>
        optimisticPatch(
          queryClient,
          orpc.folder.tree.queryKey(),
          (f) => f.id === folder.id,
          (f) => ({ ...f, name }),
        ),
      onSuccess: () => {
        toast.success(m.folder_renamed_toast())
        onOpenChange(false)
      },
      onSettled: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.folder.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.document.listDocuments.key() }),
        ]),
    }),
  )

  const form = useAppForm({
    defaultValues: { name: folder.name },
    validators: { onSubmit: schema },
    onSubmit: async ({ value, formApi }) => {
      try {
        await renameMutation.mutateAsync({ id: folder.id, name: value.name })
      } catch (err) {
        // `catch` widens to `unknown`; recover the mutation's typed error union so
        // `isDefinedError` can narrow the code (the runtime guard keeps it safe).
        const e = err as NonNullable<typeof renameMutation.error>
        // A name clash is user-fixable, so surface it inline on the field and keep
        // the dialog open; a passing Zod re-validation on the next submit clears
        // this slot. Other folder errors are not fixable here → toast.
        if (isDefinedError(e) && e.code === 'NAME_TAKEN_IN_PARENT') {
          formApi.setErrorMap({ onSubmit: { fields: { name: m.folder_error_name_taken() } } })
        } else if (isDefinedError(e)) {
          toast.error(folderErrorMessage(e.code))
        } else {
          toast.error(m.folder_rename_error())
        }
      }
    },
  })

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{m.folder_rename_title()}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>{m.folder_rename_description()}</ResponsiveDialogDescription>
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
              <form.SubmitButton label={m.common_save()} />
            </form.AppForm>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
