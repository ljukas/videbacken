import { m } from '~/paraglide/messages'

// How the cost is estimated, plus the attribution elprisetjustnu.se asks for
// in return for its free API. Shown under the cost figures on /charging.
export function PriceFootnote() {
  return (
    <div className="flex flex-col gap-1 text-muted-foreground text-xs">
      <p>{m.charging_cost_note()}</p>
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
