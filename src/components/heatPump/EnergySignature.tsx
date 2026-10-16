import { useId } from 'react'
import { formatDay, formatOneDecimal } from '~/components/evCharging/format'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import type { HeatPumpEventDto, HeatPumpEventKind } from '~/lib/heatPump/events'
import {
  SIGNATURE_MIN_DAYS,
  SIGNATURE_MIN_SPAN_C,
  type SignatureDay,
  type SignaturePoint,
  type SignatureResult,
} from '~/lib/heatPump/signature'
import { heatPumpColor } from '~/lib/houseEnergy/heatPumpColors'
import { getIntlLocale } from '~/lib/i18n/format'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { eventKindLabel } from './eventCopy'
import { SIGNATURE_CHART_HEIGHT, SignatureScatter } from './SignatureScatter'

/** A heatPump.days row (step 3) is one of these. */
export type SignatureDayRow = SignatureDay & { heatPumpId: string }

// Called at render (the locale is per request), never at module load.
const AFTER_KIND: Record<HeatPumpEventKind, () => string> = {
  service: m.heat_pump_signature_after_service,
  filter: m.heat_pump_signature_after_filter,
  setting: m.heat_pump_signature_after_setting,
  other: m.heat_pump_signature_after_other,
}

const percent = (v: number) =>
  new Intl.NumberFormat(getIntlLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(v)
/** The margin rounded up to a whole percent: never understated, "±1 %" at the least. */
const marginPercent = (v: number) => percent(Math.max(1, Math.ceil(v * 100 - 1e-9)) / 100)

const eventLabel = (e: HeatPumpEventDto) =>
  m.heat_pump_signature_event_option({
    kind: eventKindLabel(e.kind),
    date: formatDay(e.occurredOn),
  })

/** The card's one sentence for a result (spec "Readout"). */
export function signatureReadout(result: SignatureResult, kind: HeatPumpEventKind): string {
  switch (result.state) {
    case 'not_enough_before':
      return result.before < SIGNATURE_MIN_DAYS
        ? m.heat_pump_signature_not_enough_before({
            count: String(result.before),
            needed: String(SIGNATURE_MIN_DAYS),
          })
        : m.heat_pump_signature_not_enough_before_spread({ span: String(SIGNATURE_MIN_SPAN_C) })
    case 'not_enough_after':
      return m.heat_pump_signature_not_enough_after({
        count: String(result.after),
        needed: String(result.needed),
      })
    case 'ok': {
      const whole = Math.round(Math.abs(result.change) * 100)
      const params = {
        event: AFTER_KIND[kind](),
        percent: percent(whole / 100),
        margin: marginPercent(result.margin),
        after: String(result.afterDays),
        before: String(result.beforeDays),
      }
      if (whole === 0) return m.heat_pump_signature_same(params)
      return result.change < 0
        ? m.heat_pump_signature_lower(params)
        : m.heat_pump_signature_higher(params)
    }
  }
}

// The readout's reserve: room for the longest sentence (sv "…_spread", the ok sentences) at
// each width, so no state changes the card's height. Measured in Switzer 14 px at the
// card's text width: 4 lines at 288 px (a 360 px phone), 3 at 326 (390) and at 400 (768,
// sidebar open), 2 at 452 (820), at 576–703 (640–767) and at 656 (1024), 1 at 912 (1440).
const READOUT = 'min-h-[4lh] text-pretty sm:min-h-[3lh] lg:min-h-[2lh]'

// The header's controls: below the description, one per line, while the header is
// narrow (the toggle and the select never share a line that may or may not fit, so
// the header's height doesn't change with the event's label); beside the title from
// a 48rem header up, on one line.
const ACTION = cn(
  'col-span-2 col-start-1 row-span-1 row-start-3 mt-2 flex flex-col items-start gap-2 justify-self-stretch',
  '@3xl/card-header:col-span-1 @3xl/card-header:col-start-2 @3xl/card-header:row-start-1',
  '@3xl/card-header:mt-0 @3xl/card-header:flex-row @3xl/card-header:items-center @3xl/card-header:justify-self-end',
)

// The Energisignatur card (step 4b, spec "Energisignatur"). Presentational: the section
// owns the unit and event state and the reads, and passes the computed result (null while
// the event's days load). The chart is aria-hidden; the readout and the table are the
// accessible path. Every state (loading, no event, a failed read, a result) keeps the same
// box: the reserved readout, the chart or a same-height placeholder, the note, the table toggle.
export function EnergySignature({
  units,
  unitId,
  onUnitChange,
  unitEvents,
  eventId,
  onEventChange,
  result,
  failed = false,
}: {
  units: readonly { id: string; name: string }[]
  unitId: string
  onUnitChange: (id: string) => void
  unitEvents: readonly HeatPumpEventDto[]
  eventId: string | null
  onEventChange: (id: string) => void
  result: SignatureResult | null
  /** A days read failed (the section shows the alert with its retry): the readout says so instead of loading. */
  failed?: boolean
}) {
  const headingId = useId()
  const eventLabelId = useId()
  const unit = units.find((u) => u.id === unitId)
  const event = unitEvents.find((e) => e.id === eventId) ?? null
  if (!unit) return null
  const shown = event && result ? { event, result } : null
  const state = shown ? shown.result.state : !event ? 'no_event' : failed ? 'error' : 'loading'
  const readoutText = shown
    ? signatureReadout(shown.result, shown.event.kind)
    : state === 'no_event'
      ? m.heat_pump_signature_no_event({ unit: unit.name })
      : state === 'error'
        ? m.heat_pump_signature_error_title()
        : m.heat_pump_signature_loading()

  return (
    <section aria-labelledby={headingId}>
      <Card>
        <CardHeader>
          {/* As the Händelser card (and Förbrukning's heading), not CardTitle's default size. */}
          <CardTitle className="font-semibold text-lg">
            <h2 id={headingId}>{m.heat_pump_signature_title()}</h2>
          </CardTitle>
          {/* Full width under the title: its wrap doesn't depend on the controls' width. */}
          <CardDescription className="col-span-2 text-pretty">
            {m.heat_pump_signature_description()}
          </CardDescription>
          <CardAction className={ACTION}>
            {units.length > 1 ? (
              <ToggleGroup
                type="single"
                value={unit.id}
                // Radix fires '' when the active item is re-pressed; keep one selected.
                onValueChange={(v) => {
                  if (v) onUnitChange(v)
                }}
                variant="outline"
                size="sm"
                aria-label={m.heat_pump_signature_unit_label()}
              >
                {units.map((u) => (
                  <ToggleGroupItem key={u.id} value={u.id} className="pointer-coarse:min-h-11">
                    <span
                      aria-hidden
                      data-unit-swatch
                      className="size-2 shrink-0 rounded-[2px]"
                      style={{ background: heatPumpColor(units, u.id) }}
                    />
                    {u.name}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : null}
            {/* Without an event its place is held (hidden), so the header keeps its height; beside
                the title only its height counts, so it takes no width there. */}
            <div
              data-slot="signature-event-control"
              aria-hidden={event ? undefined : true}
              className={cn(
                'flex min-w-0 max-w-full items-center gap-2',
                !event && 'invisible @3xl/card-header:w-0 @3xl/card-header:overflow-hidden',
              )}
            >
              <span id={eventLabelId} className="shrink-0 text-muted-foreground">
                {m.heat_pump_signature_event_label()}
              </span>
              {event ? (
                <Select value={event.id} onValueChange={onEventChange}>
                  <SelectTrigger
                    size="sm"
                    className="pointer-coarse:min-h-11 w-auto min-w-0 max-w-full"
                    aria-labelledby={eventLabelId}
                  >
                    {/* Explicit, so SSR shows the label and the trigger keeps its width (YearSelector's rule). */}
                    <SelectValue>{eventLabel(event)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {[...unitEvents].reverse().map((e) => (
                      <SelectItem key={e.id} value={e.id}>
                        {eventLabel(e)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="h-7 pointer-coarse:min-h-11 w-32" />
              )}
            </div>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {/* One live region in every state: only its text and data-* change, so each new
              sentence is announced (a region mounted with its text is not). */}
          <p
            data-slot="signature-readout"
            data-state={state}
            data-change={shown?.result.state === 'ok' ? String(shown.result.change) : undefined}
            data-margin={shown?.result.state === 'ok' ? String(shown.result.margin) : undefined}
            aria-live="polite"
            aria-atomic="true"
            className={cn(
              READOUT,
              shown ? 'font-medium' : state !== 'no_event' && 'text-muted-foreground',
            )}
          >
            {readoutText}
          </p>
          {shown ? (
            // Keyed per unit and event: an open tooltip (by point index) never moves to another day.
            <SignatureScatter key={`${unitId}:${shown.event.id}`} result={shown.result} />
          ) : (
            <div
              data-slot="signature-chart-placeholder"
              aria-hidden
              className={cn(
                'rounded-lg bg-foreground/8',
                state === 'loading' && 'motion-safe:animate-pulse',
              )}
              style={{ height: SIGNATURE_CHART_HEIGHT }}
            />
          )}
          <p className="max-w-[70ch] text-pretty text-muted-foreground text-sm">
            {m.heat_pump_signature_note()}
          </p>
          {/* Always there, so the box keeps its height; empty until there is a result. */}
          <details className="text-sm">
            <summary className="pointer-coarse:min-h-11 w-fit cursor-pointer rounded-sm pointer-coarse:py-3 py-1 text-muted-foreground focus-visible:border-ring focus-visible:outline-1 focus-visible:outline-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
              {m.energy_flow_table_toggle()}
            </summary>
            {shown ? <SignatureTable points={shown.result.points} /> : null}
          </details>
        </CardContent>
      </Card>
    </section>
  )
}

function SignatureTable({ points }: { points: readonly SignaturePoint[] }) {
  const rows = [...points].sort((p, q) => p.day.localeCompare(q.day))
  const setLabel = (p: SignaturePoint) => {
    const set = p.set === 'before' ? m.heat_pump_signature_before() : m.heat_pump_signature_after()
    return p.extrapolated ? m.heat_pump_signature_table_not_counted({ set }) : set
  }
  return (
    // A scrolling region is a Tab stop with a name, so keyboard users can scroll it.
    <section
      aria-label={m.heat_pump_signature_table_label()}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable
      tabIndex={0}
      className="mt-2 max-h-80 overflow-auto rounded-sm focus-visible:outline-1 focus-visible:outline-ring"
    >
      <table className="min-w-full border-collapse tabular-nums">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th scope="col" className="py-1.5 pr-4 font-medium">
              {m.heat_pump_signature_table_day()}
            </th>
            <th scope="col" className="py-1.5 pr-4 text-right font-medium">
              {m.heat_pump_signature_table_delta()}
            </th>
            <th scope="col" className="py-1.5 pr-4 text-right font-medium">
              {m.heat_pump_signature_table_kwh()}
            </th>
            <th scope="col" className="py-1.5 font-medium">
              {m.heat_pump_signature_table_set()}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.day} className="border-b">
              <th scope="row" className="py-1.5 pr-4 text-left font-normal">
                {formatDay(p.day)}
              </th>
              <td className="py-1.5 pr-4 text-right">{formatOneDecimal(p.deltaT)}</td>
              <td className="py-1.5 pr-4 text-right">{formatOneDecimal(p.kwh)}</td>
              <td className="py-1.5">{setLabel(p)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
