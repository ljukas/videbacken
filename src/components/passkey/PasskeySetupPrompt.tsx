import { KeyRoundIcon } from 'lucide-react'
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
import { m } from '~/paraglide/messages'

type Props = {
  open: boolean
  pending: boolean
  onCreate: () => void
  onDismiss: () => void
}

// Explanatory prompt shown right after sign-in when the user has no passkey yet. Only
// the "Skapa passkey" button triggers the OS dialog; closing or "Inte nu" dismisses and
// suppresses the prompt for a while (handled by the caller).
export function PasskeySetupPrompt({ open, pending, onCreate, onDismiss }: Props) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss()
      }}
    >
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRoundIcon className="size-5" />
            {m.passkey_setup_title()}
          </DialogTitle>
          <DialogDescription>{m.passkey_setup_description()}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button type="button" className="w-full" disabled={pending} onClick={onCreate}>
            {pending ? <Spinner data-icon="inline-start" /> : <KeyRoundIcon />}
            {m.passkey_setup_create()}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            disabled={pending}
            onClick={onDismiss}
          >
            {m.passkey_setup_not_now()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
