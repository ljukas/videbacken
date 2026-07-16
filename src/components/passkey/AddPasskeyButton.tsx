import { useSuspenseQuery } from '@tanstack/react-query'
import { PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { PasskeyReauthDialog } from '~/components/passkey/PasskeyReauthDialog'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import { useAddPasskey } from '~/hooks/usePasskeys'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'

// The Account "Lägg till passkey" button. On the happy path (fresh session) it adds directly;
// when Better Auth rejects the add as not-fresh, it opens PasskeyReauthDialog to re-authenticate.
export function AddPasskeyButton() {
  const { data: me } = useSuspenseQuery(orpc.user.me.queryOptions())
  const [reauthOpen, setReauthOpen] = useState(false)

  const { mutate, isPending } = useAddPasskey({
    onAdded: () => toast.success(m.passkey_added()),
    onNotFresh: () => setReauthOpen(true),
  })

  return (
    <div>
      <Button onClick={() => mutate()} disabled={isPending} className="w-full sm:w-auto">
        {isPending ? <Spinner data-icon="inline-start" /> : <PlusIcon />}
        {m.passkey_add_button()}
      </Button>
      <PasskeyReauthDialog
        open={reauthOpen}
        email={me.email}
        onClose={() => setReauthOpen(false)}
      />
    </div>
  )
}
