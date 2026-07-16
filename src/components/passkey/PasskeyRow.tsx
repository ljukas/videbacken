import { Image } from '@unpic/react/base'
import { CheckIcon, KeyRoundIcon, PencilIcon, RotateCcwIcon, Trash2Icon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'
import { Button } from '~/components/ui/button'
import { FieldGroup } from '~/components/ui/field'
import { Spinner } from '~/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip'
import { useAppForm } from '~/hooks/form'
import { type Passkey, useRenamePasskey } from '~/hooks/usePasskeys'
import { formatDate } from '~/lib/i18n/format'
import { transformer } from '~/lib/image/transformer'
import { getPasskeyProvider } from '~/lib/passkeyProviders'
import { m } from '~/paraglide/messages'

const renameSchema = z.object({ name: z.string().trim().min(1) })

export function PasskeyRow({ passkey, onDelete }: { passkey: Passkey; onDelete: () => void }) {
  const renamePasskey = useRenamePasskey()
  const [isEditing, setIsEditing] = useState(false)

  const provider = getPasskeyProvider(passkey.aaguid)
  const customName = passkey.name?.trim()
  const displayName = customName || provider?.name || 'Passkey'
  const showProviderSubtitle = Boolean(customName && provider?.name)
  const isSynced = passkey.backedUp === true || passkey.deviceType === 'multiDevice'

  const createdAt =
    passkey.createdAt instanceof Date
      ? passkey.createdAt
      : passkey.createdAt
        ? new Date(passkey.createdAt)
        : null

  return (
    <li className="flex items-center justify-between gap-3 p-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {provider?.iconLight ? (
          <Image
            src={provider.iconLight}
            alt=""
            width={24}
            height={24}
            layout="fixed"
            transformer={transformer}
            className="size-6 shrink-0 rounded-sm dark:hidden"
          />
        ) : null}
        {provider?.iconDark ? (
          <Image
            src={provider.iconDark}
            alt=""
            width={24}
            height={24}
            layout="fixed"
            transformer={transformer}
            className="hidden size-6 shrink-0 rounded-sm dark:block"
          />
        ) : null}
        {!provider ? <KeyRoundIcon className="size-5 shrink-0 text-muted-foreground" /> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {isEditing ? (
            <RenamePasskeyForm passkey={passkey} onDone={() => setIsEditing(false)} />
          ) : (
            <span className="break-all font-medium text-sm">{displayName}</span>
          )}
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground text-xs">
            {showProviderSubtitle ? <span>{provider?.name}</span> : null}
            <span>{isSynced ? m.passkey_synced() : m.passkey_this_device_only()}</span>
            {createdAt ? (
              <span>{m.passkey_added_date({ date: formatDate(createdAt) })}</span>
            ) : null}
          </span>
        </div>
      </div>
      {isEditing ? null : (
        <div className="flex gap-2">
          {customName ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={m.passkey_reset_name()}
                  onClick={() => renamePasskey.mutate({ id: passkey.id, name: '' })}
                  disabled={renamePasskey.isPending}
                >
                  {renamePasskey.isPending ? <Spinner /> : <RotateCcwIcon />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{m.passkey_reset_name()}</TooltipContent>
            </Tooltip>
          ) : null}
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={m.passkey_rename()}
            onClick={() => setIsEditing(true)}
          >
            <PencilIcon />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={m.common_delete()}
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2Icon />
          </Button>
        </div>
      )}
    </li>
  )
}

function RenamePasskeyForm({ passkey, onDone }: { passkey: Passkey; onDone: () => void }) {
  const renamePasskey = useRenamePasskey()
  const form = useAppForm({
    defaultValues: { name: passkey.name ?? '' },
    validators: { onSubmit: renameSchema },
    onSubmit: async ({ value }) => {
      const trimmed = value.name.trim()
      if (trimmed === passkey.name) {
        onDone()
        return
      }
      renamePasskey.mutate({ id: passkey.id, name: trimmed }, { onSuccess: onDone })
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      <FieldGroup>
        <div className="flex items-start gap-2">
          <form.AppField
            name="name"
            children={(field) => (
              <field.TextField
                label={m.passkey_name_label()}
                srOnlyLabel
                autoFocus
                inputClassName="h-8"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') onDone()
                }}
              />
            )}
          />
          {/* Icon save button — bound SubmitButton renders a labelled button; this caller
            needs an icon-only ghost variant, so we drop to raw <form.Subscribe>.
            See ADR-0005 "The icon-button exception". */}
          <form.Subscribe
            selector={(state) => [state.canSubmit, state.isSubmitting] as const}
            children={([canSubmit, isSubmitting]) => (
              <Button
                type="submit"
                variant="ghost"
                size="icon-sm"
                aria-label={m.common_save()}
                disabled={!canSubmit || isSubmitting}
              >
                {isSubmitting ? <Spinner /> : <CheckIcon />}
              </Button>
            )}
          />
          <form.AppForm>
            <form.CancelButton
              variant="ghost"
              size="icon-sm"
              aria-label={m.common_cancel()}
              onClick={onDone}
            >
              <XIcon />
            </form.CancelButton>
          </form.AppForm>
        </div>
      </FieldGroup>
    </form>
  )
}
