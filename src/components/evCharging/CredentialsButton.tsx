import { KeyRoundIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '~/components/ui/tooltip'
import type { CredentialSource } from '~/lib/integrationCredentials'
import { credentialsButtonId } from './credentialLink'

// The key icon that opens a source's credentials dialog. Carries its own
// TooltipProvider (the app shell has one; tests and stray mounts don't). The id
// lets the dialog return focus here when it was opened from a link or the URL.
export function CredentialsButton({
  source,
  label,
  onClick,
}: {
  source: CredentialSource
  label: string
  onClick: () => void
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            id={credentialsButtonId(source)}
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            onClick={onClick}
            className="pointer-coarse:size-11"
          >
            <KeyRoundIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
