import { useId } from 'react'
import { formatDay, formatOneDecimal } from '~/components/evCharging/format'
import { Card, CardContent, CardHeader } from '~/components/ui/card'
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

const READOUT = 'min-h-[3em] text-pretty'

// The Energisignatur card (step 4b, spec "Energisignatur"). Presentational: the section
// owns the unit and event state and the reads, and passes the computed result (null while
// the event's days load). The chart is aria-hidden; the readout and the table are the
// accessible path. Every state keeps the same box: a reserved readout line, the chart or a
// same-height placeholder, the note, the table toggle.
export function EnergySignature({
  units,
  unitId,
  onUnitChange,
  unitEvents,
  eventId,
  onEventChange,
  result,
}: {
  units: readonly { id: string; name: string }[]
  unitId: string
  onUnitChange: (id: string) => void
  unitEvents: readonly HeatPumpEventDto[]
  eventId: string | null
  onEventChange: (id: string) => void
  result: SignatureResult | null
}) {
  const headingId = useId()
  const unit = units.find((u) => u.id === unitId)
  const event = unitEvents.find((e) => e.id === eventId) ?? null
  if (!unit) return null

  return (
    <section aria-labelledby={headingId}>
      <Card>
        <CardHeader className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={headingId} className="font-semibold text-lg">
              {m.heat_pump_signature_title()}
            </h2>
            <p className="text-pretty text-muted-foreground text-sm">
              {m.heat_pump_signature_description()}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
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
                  <ToggleGroupItem key={u.id} value={u.id}>
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
            {event ? (
              <Select value={event.id} onValueChange={onEventChange}>
                <SelectTrigger
                  size="sm"
                  className="w-auto max-w-full"
                  aria-label={m.heat_pump_signature_event_label()}
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
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!event ? (
            <p data-slot="signature-readout" data-state="no_event" className={READOUT}>
              {m.heat_pump_signature_no_event({ unit: unit.name })}
            </p>
          ) : (
            <>
              {result ? (
                <p
                  data-slot="signature-readout"
                  data-state={result.state}
                  data-change={result.state === 'ok' ? String(result.change) : undefined}
                  data-margin={result.state === 'ok' ? String(result.margin) : undefined}
                  aria-live="polite"
                  className={`${READOUT} font-medium`}
                >
                  {signatureReadout(result, event.kind)}
                </p>
              ) : (
                <p
                  data-slot="signature-readout"
                  data-state="loading"
                  className={`${READOUT} text-muted-foreground`}
                >
                  {m.heat_pump_signature_loading()}
                </p>
              )}
              {result ? (
                <SignatureScatter result={result} />
              ) : (
                <div
                  data-slot="signature-chart-placeholder"
                  aria-hidden
                  className="rounded-lg bg-foreground/8 motion-safe:animate-pulse"
                  style={{ height: SIGNATURE_CHART_HEIGHT }}
                />
              )}
              <p className="max-w-[70ch] text-pretty text-muted-foreground text-sm">
                {m.heat_pump_signature_note()}
              </p>
              <details className="text-sm">
                <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground focus-visible:border-ring focus-visible:outline-1 focus-visible:outline-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
                  {m.energy_flow_table_toggle()}
                </summary>
                {result ? <SignatureTable points={result.points} /> : null}
              </details>
            </>
          )}
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
