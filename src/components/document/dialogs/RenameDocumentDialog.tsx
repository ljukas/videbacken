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
import { documentErrorMessage } from '~/lib/orpc/documentErrorMessage'
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
  document: { id: string; name: string; extension: string | null; folderId: string | null }
}

export function RenameDocumentDialog({ open, onOpenChange, document }: Props) {
  const queryClient = useQueryClient()

  const renameMutation = useMutation(
    orpc.document.renameDocument.mutationOptions({
      // Paint the new name into the row's scoped list cache before the round-trip.
      onMutate: ({ name }) =>
        optimisticPatch(
          queryClient,
          orpc.document.listDocuments.queryKey({ input: { folderId: document.folderId } }),
          (d) => d.id === document.id,
          (d) => ({ ...d, name }),
        ),
      // These live on useMutation (not the mutate call) so they still run after we
      // close the dialog below: TanStack Query fires useMutation callbacks
      // regardless of unmount, mutate callbacks don't. No success toast — the
      // optimistic rename is the confirmation; the error toast is the one signal
      // we deliberately keep post-close. onSettled reverts the patch on failure.
      onError: (err) =>
        toast.error(
          isDefinedError(err) ? documentErrorMessage(err.code) : m.document_rename_error(),
        ),
      onSettled: () =>
        queryClient.invalidateQueries({ queryKey: orpc.document.listDocuments.key() }),
    }),
  )

  const form = useAppForm({
    defaultValues: { name: document.name },
    validators: { onSubmit: schema },
    onSubmit: ({ value }) => {
      // Optimistic instant-close: onMutate paints the new name, we close the dialog
      // immediately, and onError/onSettled reconcile in the background. Document
      // rename has no user-fixable failure, so there's nothing to keep it open for.
      renameMutation.mutate({ id: document.id, name: value.name })
      onOpenChange(false)
    },
  })

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{m.document_rename_title()}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {document.extension
              ? m.document_rename_description_extension()
              : m.document_rename_description()}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            form.handleSubmit()
          }}
        >
          <form.AppField name="name">
            {(field) => (
              <field.TextField
                label={m.document_name_label()}
                autoComplete="off"
                autoFocus
                suffix={document.extension ? `.${document.extension}` : undefined}
              />
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
