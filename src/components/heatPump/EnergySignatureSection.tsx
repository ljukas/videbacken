import { useQueries, useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import signatureBones from '~/bones/heat-pumps-signature.bones.json'
import {
  firstLoadPending,
  LoadErrorAlert,
  type LoadErrorQuery,
  loadFailed,
} from '~/components/layout/LoadErrorAlert'
import { SectionSkeleton } from '~/components/layout/SectionSkeleton'
import type { HeatPumpEventDto } from '~/lib/heatPump/events'
import {
  energySignature,
  eventsForUnit,
  selectedEventId,
  signatureChunks,
  signatureRange,
} from '~/lib/heatPump/signature'
import { byHeatPumpName } from '~/lib/houseEnergy/figures'
import { stockholmDayOf } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'
import { EnergySignature, type SignatureDayRow } from './EnergySignature'
import { heatPumpDaysQuery, heatPumpEventsQuery, heatPumpMonthsQueryFor } from './heatPumpQueries'

const NO_EVENTS: HeatPumpEventDto[] = []

type DaysChunk = LoadErrorQuery & { data: { days: readonly SignatureDayRow[] } | undefined }

// Module-level, so TanStack keeps the combined result while no chunk changes (a stable
// combine is memoised): the days array, and with it the signature, keeps its identity.
function concatChunks(chunks: readonly DaysChunk[]) {
  return {
    days:
      chunks.length > 0 && chunks.every((c) => c.data !== undefined)
        ? chunks.flatMap((c) => c.data?.days ?? [])
        : null,
    failed: chunks.find(loadFailed) ?? null,
  }
}

// The Energisignatur section (step 4b): the unit and event state, and three reads.
// Units and the first reading day come from step 3's months query (the page's default
// cache entry), the events from step 4a's list (deferred in the loader), and the chosen
// event's days (400 days before it, not before the first reading, to the unit's next
// event or today) from heatPump.days in parallel chunks of ≤ HEAT_PUMP_DAYS_MAX days.
export function EnergySignatureSection({ today: given }: { today?: string } = {}) {
  // Fixed for the page's life: a range that moved at midnight would refetch mid-view.
  const [today] = useState(() => given ?? stockholmDayOf(Date.now()))
  const months = useQuery(heatPumpMonthsQueryFor(null))
  const events = useQuery(heatPumpEventsQuery)
  const [unitId, setUnitId] = useState<string | null>(null)
  const [chosenEventId, setChosenEventId] = useState<string | null>(null)

  const units = useMemo(
    () => (months.data?.units ?? []).map(({ id, name }) => ({ id, name })).sort(byHeatPumpName),
    [months.data],
  )
  const unit = units.find((u) => u.id === unitId) ?? units[0] ?? null
  const eventList = events.data ?? NO_EVENTS
  const unitEvents = useMemo(
    () => (unit ? eventsForUnit(eventList, unit.id) : []),
    [eventList, unit],
  )
  const eventId = unit ? selectedEventId(eventList, unit.id, chosenEventId) : null
  const range =
    unit && eventId
      ? signatureRange({
          events: eventList,
          heatPumpId: unit.id,
          eventId,
          firstReadingDay: months.data?.firstReadingDay ?? null,
          today,
        })
      : null
  const from = range?.from
  const to = range?.to
  const ranges = useMemo(() => (from && to ? signatureChunks(from, to) : []), [from, to])
  const chunks = useQueries({
    queries: ranges.map((r) => heatPumpDaysQuery(r)),
    combine: concatChunks,
  })
  const result = useMemo(
    () =>
      unit && eventId && chunks.days
        ? energySignature({
            days: chunks.days.filter((d) => d.heatPumpId === unit.id),
            events: eventList,
            heatPumpId: unit.id,
            eventId,
          })
        : null,
    [unit, eventId, chunks.days, eventList],
  )

  // Months failing is step 3's alert (its critical read); this section then renders nothing.
  const failed = loadFailed(months) || loadFailed(events)
  return (
    <>
      <SectionSkeleton
        bones={signatureBones}
        loading={!failed && (firstLoadPending(months) || firstLoadPending(events))}
        fallbackHeight="36rem"
      >
        {unit && !failed ? (
          <EnergySignature
            units={units}
            unitId={unit.id}
            // Switching unit resets to that unit's default event (spec).
            onUnitChange={(id) => {
              setUnitId(id)
              setChosenEventId(null)
            }}
            unitEvents={unitEvents}
            eventId={eventId}
            onEventChange={setChosenEventId}
            result={result}
          />
        ) : null}
      </SectionSkeleton>
      {chunks.failed ? (
        <LoadErrorAlert title={m.heat_pump_signature_error_title()} query={chunks.failed} />
      ) : null}
    </>
  )
}
