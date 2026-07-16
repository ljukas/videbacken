import { CheckIcon, KeyRoundIcon, MailIcon, ShieldCheckIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Spinner } from '~/components/ui/spinner'
import { useAwaitFreshSession } from '~/hooks/useAwaitFreshSession'
import { useAddPasskey } from '~/hooks/usePasskeys'
import { authClient } from '~/lib/authClient'
import { m } from '~/paraglide/messages'

type Props = {
  open: boolean
  email: string
  onClose: () => void
}

// Shown when adding a passkey fails because the session is no longer fresh (older than
// `freshAge`, see src/lib/auth.ts). Better Auth requires recent authentication for credential
// changes, so we send a fresh magic link and let the user finish the add — the same magic-link
// re-entry flow as login (authClient.signIn.magicLink → /signed-in), without leaving Account.
export function PasskeyReauthDialog({ open, email, onClose }: Props) {
  const [state, setState] = useState<'prompt' | 'sent'>('prompt')
  const [sending, setSending] = useState(false)
  const [fresh, setFresh] = useState(false)
  const [hint, setHint] = useState<string | null>(null)

  // Reset to a clean slate every time the dialog opens.
  useEffect(() => {
    if (!open) return
    setState('prompt')
    setSending(false)
    setFresh(false)
    setHint(null)
  }, [open])

  const addPasskey = useAddPasskey({
    onAdded: () => {
      toast.success(m.passkey_added())
      onClose()
    },
    onNotFresh: () => setHint(m.passkey_reauth_not_fresh_hint()),
  })

  // Cosmetic: flip the status copy once the magic link re-freshens the session in the other tab.
  useAwaitFreshSession({
    enabled: open && state === 'sent' && !fresh,
    onFresh: () => setFresh(true),
  })

  async function sendLink() {
    setSending(true)
    const { error } = await authClient.signIn.magicLink({
      email,
      callbackURL: '/signed-in?redirect=/account',
    })
    setSending(false)
    if (error) {
      toast.error(error.message ?? m.login_send_error())
      return
    }
    setState('sent')
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent showCloseButton={!addPasskey.isPending}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheckIcon className="size-5" />
            {m.passkey_reauth_title()}
          </DialogTitle>
          <DialogDescription>
            {state === 'prompt' ? (
              <>
                {m.passkey_reauth_prompt_prefix()}{' '}
                <strong className="text-foreground">{email}</strong>.
              </>
            ) : (
              <>
                {m.passkey_reauth_sent_prefix()}{' '}
                <strong className="text-foreground">{email}</strong>.{' '}
                {m.passkey_reauth_sent_suffix()}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {state === 'sent' && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            {fresh ? (
              <>
                <CheckIcon className="size-4 text-primary" />
                {m.passkey_reauth_confirmed()}
              </>
            ) : (
              <>
                <Spinner className="size-4" />
                {m.passkey_reauth_waiting()}
              </>
            )}
          </div>
        )}

        {hint && <p className="text-destructive text-sm">{hint}</p>}

        <DialogFooter>
          {state === 'prompt' ? (
            <Button type="button" className="w-full" disabled={sending} onClick={sendLink}>
              {sending ? <Spinner data-icon="inline-start" /> : <MailIcon />}
              {m.login_submit()}
            </Button>
          ) : (
            <Button
              type="button"
              className="w-full"
              disabled={addPasskey.isPending}
              onClick={() => {
                setHint(null)
                addPasskey.mutate()
              }}
            >
              {addPasskey.isPending ? <Spinner data-icon="inline-start" /> : <KeyRoundIcon />}
              {m.passkey_add_button()}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
