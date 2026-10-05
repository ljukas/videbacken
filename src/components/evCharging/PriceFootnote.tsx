import { m } from '~/paraglide/messages'
import { formatDate } from './format'

// How the cost is estimated, plus the attribution elprisetjustnu.se asks for
// in return for its free API. On the overview (`coverage` given) it also says
// what the cash cost counts: solar and battery from the first house data on
// (ADR-0023). The economy views omit it: they price everything as bought.
export function PriceFootnote({ coverage }: { coverage?: { houseDataFrom: Date | null } }) {
  return (
    <div className="flex flex-col gap-1 text-muted-foreground text-xs">
      <p>{m.charging_cost_note()}</p>
      {coverage ? (
        <p>
          {coverage.houseDataFrom
            ? m.charging_cost_note_mix({ date: formatDate(coverage.houseDataFrom) })
            : m.charging_cost_note_all_grid()}
        </p>
      ) : null}
      <p>
        {m.charging_prices_attribution()}{' '}
        <a
          href="https://www.elprisetjustnu.se"
          target="_blank"
          rel="noopener noreferrer"
          translate="no"
          className="underline underline-offset-4 hover:text-foreground"
        >
          Elpriset just nu.se
        </a>
      </p>
    </div>
  )
}
