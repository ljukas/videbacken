import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { Estimated } from './Estimated'
import { formatOneDecimal, formatScore, formatSek, formatSignedSek, formatTime } from './format'
import { GuestBadge } from './GuestBadge'
import { SessionLink } from './SessionLink'
import { Unknown } from './Unknown'

type Row = RouterOutputs['evCharging']['economy']['sessions'][number]

const noSpread = (cf: NonNullable<Row['counterfactual']>) =>
  m.charging_economy_tile_no_spread({
    spread: formatSek(cf.dearest.totalSek - cf.optimal.totalSek, 2),
  })

const reason = (r: Row) =>
  r.excluded === 'no_hourly'
    ? m.charging_economy_reason_no_hourly()
    : m.charging_economy_reason_no_price()

// One page of the selected year's sessions, newest first (the route slices it). Excluded
// sessions keep their actual cost when it is complete and say why the
// comparison is missing. < sm the comparison folds under the date, like
// SessionList.
export function EconomySessionTable({
  sessions,
  labelledBy,
}: {
  sessions: Row[]
  labelledBy?: string
}) {
  return (
    <Table aria-labelledby={labelledBy}>
      <TableHeader>
        <TableRow>
          <TableHead>{m.charging_economy_col_date()}</TableHead>
          <TableHead className="text-right">{m.charging_economy_col_energy()}</TableHead>
          <TableHead className="text-right">{m.charging_economy_col_actual()}</TableHead>
          <TableHead className="hidden text-right sm:table-cell">
            {m.charging_economy_col_vs_immediate()}
          </TableHead>
          <TableHead className="hidden text-right sm:table-cell">
            {m.charging_economy_col_left()}
          </TableHead>
          <TableHead className="hidden text-right sm:table-cell">
            {m.charging_economy_col_score()}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sessions.map((r) => {
          const cf = r.counterfactual
          return (
            <TableRow key={r.sessionId}>
              <TableCell className="whitespace-nowrap">
                <div className="flex items-center gap-2">
                  <SessionLink sessionId={r.sessionId} startAt={r.startAt} />
                  {r.vehicle === 'other' ? <GuestBadge /> : null}
                </div>
                <div className="text-muted-foreground text-xs tabular-nums">
                  {formatTime(r.startAt)}–{formatTime(r.endAt)}
                </div>
                <div className="whitespace-normal text-muted-foreground text-xs tabular-nums sm:hidden">
                  {cf ? (
                    <>
                      <FoldedValue
                        label={m.charging_economy_col_vs_immediate()}
                        value={formatSignedSek(cf.savedVsImmediateSek, 2)}
                      />{' '}
                      <FoldedValue
                        label={m.charging_economy_col_left()}
                        value={formatSignedSek(cf.leftOnTableSek, 2)}
                      />{' '}
                      <FoldedValue
                        label={m.charging_economy_col_score()}
                        value={formatScore(cf.score)}
                        unknownLabel={cf.score === null ? noSpread(cf) : undefined}
                      />
                    </>
                  ) : (
                    reason(r)
                  )}
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap text-right tabular-nums">
                {formatOneDecimal(r.kwh)} kWh
              </TableCell>
              <TableCell className="whitespace-nowrap text-right tabular-nums">
                {r.actualComplete ? (
                  // No hourly data means the cost was spread from the total: an estimate.
                  <Estimated estimated={r.excluded === 'no_hourly'}>
                    {formatSek(r.actual.totalSek, 2)}
                  </Estimated>
                ) : (
                  <Unknown label={m.charging_sessions_cost_unknown()} />
                )}
              </TableCell>
              {cf ? (
                <>
                  <TableCell className="hidden whitespace-nowrap text-right tabular-nums sm:table-cell">
                    {formatSignedSek(cf.savedVsImmediateSek, 2)}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-right tabular-nums sm:table-cell">
                    {formatSignedSek(cf.leftOnTableSek, 2)}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-right tabular-nums sm:table-cell">
                    {cf.score === null ? <Unknown label={noSpread(cf)} /> : formatScore(cf.score)}
                  </TableCell>
                </>
              ) : (
                <TableCell
                  colSpan={3}
                  className="hidden text-right text-muted-foreground text-xs sm:table-cell"
                >
                  — {reason(r)}
                </TableCell>
              )}
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

// One labelled value, wrapped whole so a line break falls between values.
// The headers are hidden below `sm`, so the label travels with the value.
function FoldedValue({
  label,
  value,
  unknownLabel,
}: {
  label: string
  value: string
  /** Set when the value is unknown: the reason, read out in place of the dash. */
  unknownLabel?: string
}) {
  return (
    <span className="inline-block">
      {label} {unknownLabel ? <Unknown label={unknownLabel} /> : value}
    </span>
  )
}
