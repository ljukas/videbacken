import { SearchIcon } from 'lucide-react'
import { useCommandPalette } from '~/components/command/useCommandPalette'
import { Button } from '~/components/ui/button'
import { useModKeyLabel } from '~/hooks/useModKeyLabel'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

/**
 * The search-field affordance that opens the global command palette. Mirrors the
 * old `DocumentSearch` trigger (outline field + ⌘K hint). Rendered centered in the
 * mobile header bar, where the sidebar (and its own compact `SidebarMenuButton`
 * search trigger) is collapsed into a drawer; on desktop the sidebar rail trigger
 * is always visible, so this one is `md:hidden` via its host header.
 */
export function CommandTriggerButton({ className }: { className?: string }) {
  const { setOpen } = useCommandPalette()
  const hotkeyLabel = useModKeyLabel()

  return (
    <Button
      variant="outline"
      className={cn('w-full justify-start gap-2 text-muted-foreground', className)}
      onClick={() => setOpen(true)}
      aria-label={m.cmd_trigger_label()}
    >
      <SearchIcon data-icon="inline-start" />
      <span className="flex-1 text-left">{m.cmd_trigger_label()}</span>
      {hotkeyLabel ? (
        <kbd className="pointer-events-none hidden h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground sm:inline-flex">
          {hotkeyLabel}
        </kbd>
      ) : null}
    </Button>
  )
}
