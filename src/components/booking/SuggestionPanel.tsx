import { CheckIcon, XIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import type { Suggestion } from '~/lib/services/booking/logic'
import type { ShareCode } from '~/lib/shares/codes'
import { m } from '~/paraglide/messages'

type SuggestionPanelProps = {
  suggestion: Suggestion
  onApply: () => void
  applying: boolean
}

// Quiet banner (ADR-0020 §UI): satisfaction summary + move pills
// (cycles, auto-granted extras) + apply, then a per-share wish-status row —
// brand tint for shares whose trade wish the suggestion fulfills, muted for
// those it can't, each unmet chip naming what the share wished for.
// Contested extras are listed for manual assignment — deliberately no
// fairness algorithm.
export function SuggestionPanel({ suggestion, onApply, applying }: SuggestionPanelProps) {
  const pills = [
    ...suggestion.cycles.map((cycle) =>
      cycle.length === 2 ? `${cycle[0]} ↔ ${cycle[1]}` : [...cycle, cycle[0]].join(' → '),
    ),
    ...suggestion.autoExtras.map((x) => `${x.firstWeek}–${x.lastWeek} → ${x.holder}`),
  ]
  const hasMoves = pills.length > 0
  const satisfied = new Set(suggestion.satisfiedShares)
  const unmetTargets = new Map<ShareCode, Array<ShareCode>>()
  for (const wish of suggestion.unsatisfiedTradeWishes) {
    unmetTargets.set(wish.shareCode, [
      ...(unmetTargets.get(wish.shareCode) ?? []),
      wish.targetShare,
    ])
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-brand/5 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">
          {hasMoves
            ? m.booking_suggestion_summary({
                satisfied: suggestion.satisfiedShares.length,
                total: suggestion.tradeWishShares.length,
              })
            : m.booking_suggestion_none()}
        </p>
        {hasMoves ? (
          <Button size="sm" className="ml-auto" onClick={onApply} disabled={applying}>
            {m.booking_suggestion_apply()}
          </Button>
        ) : null}
      </div>
      {hasMoves ? (
        <div className="flex flex-wrap gap-1.5">
          {pills.map((pill) => (
            <span
              key={pill}
              className="rounded-full bg-brand/10 px-2 py-0.5 text-brand text-xs tabular-nums"
            >
              {pill}
            </span>
          ))}
        </div>
      ) : null}
      {suggestion.tradeWishShares.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {suggestion.tradeWishShares.map((share) =>
            satisfied.has(share) ? (
              <span
                key={share}
                className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-brand text-xs tabular-nums"
              >
                <CheckIcon className="size-3" aria-hidden />
                <span aria-hidden>{share}</span>
                <span className="sr-only">{m.booking_suggestion_wish_met_sr({ share })}</span>
              </span>
            ) : (
              <span
                key={share}
                className="inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-muted-foreground text-xs tabular-nums"
              >
                <XIcon className="size-3" aria-hidden />
                <span
                  aria-hidden
                >{`${share} → ${(unmetTargets.get(share) ?? []).join(', ')}`}</span>
                <span className="sr-only">{m.booking_suggestion_wish_unmet_sr({ share })}</span>
              </span>
            ),
          )}
        </div>
      ) : null}
      {suggestion.openExtras.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          {m.booking_suggestion_open_extras({
            list: suggestion.openExtras
              .map((x) => `${x.firstWeek}–${x.lastWeek} (${x.interested.join(', ')})`)
              .join(' · '),
          })}
        </p>
      ) : null}
    </div>
  )
}
