import { Button } from '~/components/ui/button'
import { m } from '~/paraglide/messages'

type ArrangeBarProps = {
  // "A · 21–22" while a block is selected, else null.
  selectedLabel: string | null
  draftExists: boolean
  onReset: () => void
  resetting: boolean
  onDone: () => void
}

// Slim select-then-act bar (ADR-0020 §UI): hint text, the admin-only draft
// chip, reset (escape hatch to nominal) and done (exit arrange mode).
export function ArrangeBar({
  selectedLabel,
  draftExists,
  onReset,
  resetting,
  onDone,
}: ArrangeBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm">
      <p className="text-muted-foreground" aria-live="polite">
        {selectedLabel
          ? m.booking_arrange_selected_hint({ block: selectedLabel })
          : m.booking_arrange_hint()}
      </p>
      <div className="ml-auto flex items-center gap-2">
        {draftExists ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
            {m.booking_draft_chip()}
          </span>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onReset} disabled={resetting}>
          {m.booking_reset()}
        </Button>
        <Button variant="outline" size="sm" onClick={onDone}>
          {m.booking_arrange_done()}
        </Button>
      </div>
    </div>
  )
}
