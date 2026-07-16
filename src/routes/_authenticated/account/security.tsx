import { createFileRoute } from '@tanstack/react-router'
import { KeyRoundIcon } from 'lucide-react'
import { useState } from 'react'
import { AddPasskeyButton } from '~/components/passkey/AddPasskeyButton'
import { DeletePasskeyDialog } from '~/components/passkey/DeletePasskeyDialog'
import { PasskeyRow } from '~/components/passkey/PasskeyRow'
import { TooltipProvider } from '~/components/ui/tooltip'
import { useListPasskeys } from '~/hooks/usePasskeys'
import { m } from '~/paraglide/messages'

// Security subpage: passkey management (lifted verbatim from the old single-page
// account route). Sessions / API keys are out of scope — magic-link + passkeys
// only (see the redesign plan).
export const Route = createFileRoute('/_authenticated/account/security')({
  component: AccountSecurity,
})

function AccountSecurity() {
  const { data: passkeys = [], isLoading } = useListPasskeys()
  const [deletePasskeyId, setDeletePasskeyId] = useState<string | null>(null)

  return (
    <TooltipProvider>
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h2 className="font-semibold text-xl">{m.account_passkeys_heading()}</h2>
          <p className="text-muted-foreground text-sm">{m.account_passkeys_description()}</p>
        </div>

        <AddPasskeyButton />

        <div className="rounded-lg border bg-surface-raised">
          {isLoading ? (
            <div className="p-6 text-center text-muted-foreground text-sm">
              {m.common_loading()}
            </div>
          ) : passkeys.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-8 text-center">
              <KeyRoundIcon className="size-8 text-muted-foreground" />
              <p className="font-medium text-sm">{m.account_passkeys_empty_title()}</p>
              <p className="text-muted-foreground text-sm">
                {m.account_passkeys_empty_description()}
              </p>
            </div>
          ) : (
            <ul className="divide-y">
              {passkeys.map((pk) => (
                <PasskeyRow key={pk.id} passkey={pk} onDelete={() => setDeletePasskeyId(pk.id)} />
              ))}
            </ul>
          )}
        </div>

        <DeletePasskeyDialog passkeyId={deletePasskeyId} onClose={() => setDeletePasskeyId(null)} />
      </section>
    </TooltipProvider>
  )
}
