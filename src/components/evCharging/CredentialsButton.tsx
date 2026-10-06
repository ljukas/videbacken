import { KeyRoundIcon } from 'lucide-react'
import { useRef, useState } from 'react'
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
  const button = useRef<HTMLButtonElement>(null)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  return (
    <TooltipProvider>
      <Tooltip
        open={tooltipOpen}
        onOpenChange={(open) => {
          // Hover or keyboard focus shows the tooltip. Focus put back here by a
          // dialog closed with the mouse or a tap isn't :focus-visible, so it
          // doesn't pop the tooltip up on its own.
          const el = button.current
          if (open && el && !el.matches(':hover') && !el.matches(':focus-visible')) return
          setTooltipOpen(open)
        }}
      >
        <TooltipTrigger asChild>
          <Button
            ref={button}
            id={credentialsButtonId(source)}
            variant="ghost"
            size="icon-sm"
            // The name never depends on the tooltip, which may stay closed.
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
