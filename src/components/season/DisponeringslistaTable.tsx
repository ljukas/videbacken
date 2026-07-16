import { StarIcon } from 'lucide-react'
import type { MonthBand, ShareBlock, YearSchedule } from '~/lib/services/season/logic'
import { type ShareCode, WEEKS_PER_SHARE } from '~/lib/shares/codes'
import { shareBackgroundClass } from '~/lib/shares/colors'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { MONTH_LABELS, OWNED_RING } from './calendar'

type Props = {
  schedules: Array<YearSchedule>
  currentYear: number
  ownedShareCodes: ReadonlySet<ShareCode>
}

export function DisponeringslistaTable({ schedules, currentYear, ownedShareCodes }: Props) {
  // Newest first: the seasons owners actually check (current + next) sit at
  // the top of the Disponeringslista, history below. buildSchedules returns
  // chronological order — ordering the list for the reader is this view's
  // decision (precedent: the render-time toSorted() in DocumentTable).
  const displaySchedules = schedules.toReversed()

  return (
    <section className="flex flex-col gap-3 lg:min-h-0 lg:flex-1">
      <h2 className="text-center font-heading font-semibold text-lg tracking-tight">
        {m.season_disponeringslista_title()}
      </h2>
      <WideLayout
        schedules={displaySchedules}
        ownedShareCodes={ownedShareCodes}
        currentYear={currentYear}
      />
      <MobileLayout
        schedules={displaySchedules}
        ownedShareCodes={ownedShareCodes}
        currentYear={currentYear}
      />
    </section>
  )
}

type LayoutProps = Props

function WideLayout({ schedules, ownedShareCodes, currentYear }: LayoutProps) {
  return (
    <div className="hidden min-h-0 overflow-auto rounded-lg border bg-surface-raised lg:-mx-4 lg:block">
      <table className="w-full text-sm">
        <tbody>
          {schedules.map((s, yearIdx) => {
            const isCurrent = s.year === currentYear
            // Weeks where a band ends (right border on the data + headers).
            const monthEndWeeks = new Set(s.monthBands.slice(0, -1).map((b) => b.lastWeek))
            const isFirstYear = yearIdx === 0

            return (
              <YearBlock
                key={s.year}
                schedule={s}
                isCurrent={isCurrent}
                isFirstYear={isFirstYear}
                monthEndWeeks={monthEndWeeks}
                ownedShareCodes={ownedShareCodes}
              />
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

type YearBlockProps = {
  schedule: YearSchedule
  isCurrent: boolean
  isFirstYear: boolean
  monthEndWeeks: Set<number>
  ownedShareCodes: ReadonlySet<ShareCode>
}

function YearBlock({
  schedule: s,
  isCurrent,
  isFirstYear,
  monthEndWeeks,
  ownedShareCodes,
}: YearBlockProps) {
  const lastBandIdx = s.monthBands.length - 1
  // First row of every year (except the very first) gets the heavy top border
  // that separates one year-block from the next.
  const yearTop = isFirstYear ? '' : 'border-t-2 border-border'

  return (
    <>
      <tr className={cn('text-muted-foreground text-xs uppercase tracking-wider', yearTop)}>
        <th
          rowSpan={3}
          className={cn(
            'w-[1%] whitespace-nowrap border-r bg-muted px-2 text-left font-semibold text-foreground text-sm tabular-nums',
          )}
        >
          {s.year}
        </th>
        {s.monthBands.map((band, i) => (
          <th
            key={band.firstWeek}
            colSpan={band.span}
            className={cn('bg-muted py-1 text-center font-semibold', i < lastBandIdx && 'border-r')}
          >
            {MONTH_LABELS[band.month]?.()}
          </th>
        ))}
      </tr>
      <tr className="text-muted-foreground text-xs">
        {s.monthBands.flatMap((band) =>
          Array.from({ length: band.span }, (_, i) => {
            const week = band.firstWeek + i
            return (
              <td
                key={week}
                className={cn(
                  'border-b bg-muted px-1 py-0.5 text-center font-normal tabular-nums',
                  monthEndWeeks.has(week) && 'border-r',
                )}
              >
                {week}
              </td>
            )
          }),
        )}
      </tr>
      <tr>
        {s.blocks.map((block) => {
          const isMine = ownedShareCodes.has(block.shareCode)
          return (
            <td
              key={block.firstWeek}
              colSpan={WEEKS_PER_SHARE}
              aria-label={
                isMine
                  ? m.season_my_weeks({
                      from: block.firstWeek,
                      to: block.lastWeek,
                      share: block.shareCode,
                    })
                  : undefined
              }
              className={cn(
                'relative px-1 py-2 text-center font-medium',
                monthEndWeeks.has(block.lastWeek) && 'border-r',
                isCurrent
                  ? cn(shareBackgroundClass[block.shareCode], 'font-bold text-foreground')
                  : 'text-muted-foreground',
                isMine && OWNED_RING,
              )}
            >
              {block.shareCode}
            </td>
          )
        })}
      </tr>
    </>
  )
}

function MobileLayout({ schedules, ownedShareCodes, currentYear }: LayoutProps) {
  // No inner scroll: below lg the PAGE scrolls (PageContainer fill="lg"), so
  // the scrollbar sits at the panel edge instead of beside the cards.
  return (
    <div className="flex flex-col gap-4 lg:hidden">
      {schedules.map((s) => (
        <YearCard
          key={s.year}
          schedule={s}
          isCurrent={s.year === currentYear}
          ownedShareCodes={ownedShareCodes}
        />
      ))}
    </div>
  )
}

type YearCardProps = {
  schedule: YearSchedule
  isCurrent: boolean
  ownedShareCodes: ReadonlySet<ShareCode>
}

function YearCard({ schedule, isCurrent, ownedShareCodes }: YearCardProps) {
  // No ring on the current card: the star + colored rows already mark it,
  // and a translucent ring stacked outside the hairline border rendered as
  // a smudged double edge.
  return (
    <article className="overflow-hidden rounded-lg border bg-surface-raised">
      <header className="flex items-center gap-2 border-b bg-muted px-4 py-2">
        {isCurrent && <StarIcon className="size-4 text-primary" aria-hidden />}
        <span className="font-semibold tabular-nums">{schedule.year}</span>
      </header>
      <div className="flex flex-col">
        {schedule.monthBands.map((band) => {
          const blocks = schedule.blocks.filter(
            (b) => b.firstWeek >= band.firstWeek && b.firstWeek <= band.lastWeek,
          )
          // A band holding only the tail week of a block (e.g. a 1-week Okt
          // band after the 39–40 block) gets no section — the block's row
          // already sits under its starting month.
          if (blocks.length === 0) return null
          return (
            <MonthSection
              key={band.firstWeek}
              band={band}
              blocks={blocks}
              isCurrent={isCurrent}
              ownedShareCodes={ownedShareCodes}
            />
          )
        })}
      </div>
    </article>
  )
}

type MonthSectionProps = {
  band: MonthBand
  blocks: Array<ShareBlock>
  isCurrent: boolean
  ownedShareCodes: ReadonlySet<ShareCode>
}

function MonthSection({ band, blocks, isCurrent, ownedShareCodes }: MonthSectionProps) {
  return (
    <section className="border-b last:border-b-0">
      <h3 className="bg-muted/50 px-4 py-1 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
        {MONTH_LABELS[band.month]?.()}
      </h3>
      <div className="flex flex-col">
        {blocks.map((block, i) => {
          const isMine = ownedShareCodes.has(block.shareCode)
          return (
            <div
              key={block.firstWeek}
              className={cn(
                'flex items-center justify-between gap-2 px-4 py-2',
                i > 0 && 'border-t',
                isCurrent && shareBackgroundClass[block.shareCode],
                isMine && OWNED_RING,
              )}
            >
              {isMine && (
                <span className="sr-only">
                  {m.season_my_weeks({
                    from: block.firstWeek,
                    to: block.lastWeek,
                    share: block.shareCode,
                  })}
                </span>
              )}
              <span
                aria-hidden={isMine || undefined}
                className={cn(
                  'tabular-nums',
                  isCurrent ? 'text-foreground/80' : 'text-muted-foreground',
                )}
              >
                {block.firstWeek}–{block.lastWeek}
              </span>
              <span
                aria-hidden={isMine || undefined}
                className={cn(
                  'font-semibold',
                  isCurrent ? 'font-bold text-foreground' : 'text-muted-foreground',
                )}
              >
                {block.shareCode}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
