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
import {
  formatDate,
  formatOneDecimal,
  formatScore,
  formatSek,
  formatSignedSek,
  formatTime,
} from './format'

type Row = RouterOutputs['evCharging']['economy']['sessions'][number]

const reason = (r: Row) =>
  r.excluded === 'no_hourly'
    ? m.charging_economy_reason_no_hourly()
    : m.charging_economy_reason_no_price()

// The selected year's sessions, newest first (~100/yr → no paging). Excluded
// sessions keep their actual cost when it is complete and say why the
// comparison is missing. < sm the comparison folds under the date, like
// SessionList.
export function EconomySessionTable({ sessions }: { sessions: Row[] }) {
  return (
    <Table>
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
                <SessionDate row={r} />
                <div className="text-muted-foreground text-xs tabular-nums">
                  {formatTime(r.startAt)}–{formatTime(r.endAt)}
                </div>
                <div className="text-muted-foreground text-xs tabular-nums sm:hidden">
                  {cf
                    ? `${formatSignedSek(cf.savedVsImmediateSek, 2)} · ${formatSignedSek(cf.leftOnTableSek, 2)} · ${formatScore(cf.score)}`
                    : reason(r)}
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap text-right tabular-nums">
                {formatOneDecimal(r.kwh)} kWh
              </TableCell>
              <TableCell className="whitespace-nowrap text-right tabular-nums">
                {r.actualComplete ? formatSek(r.actual.totalSek, 2) : '—'}
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
                    {formatScore(cf.score)}
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

// C1 turns this into a link to the session page.
function SessionDate({ row }: { row: Row }) {
  return <span>{formatDate(row.startAt)}</span>
}
