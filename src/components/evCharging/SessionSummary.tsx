import {
  ArrowDownIcon,
  ArrowUpIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleMinusIcon,
  InfoIcon,
  MinusIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import type * as React from 'react'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Card } from '~/components/ui/card'
import {
  rangePosition,
  summarySentence,
  type TimingVerdict,
  timingVerdict,
} from '~/lib/evCharging/economy/verdict'
import type { RouterOutputs } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { Estimated } from './Estimated'
import {
  formatKronor,
  formatOneDecimal,
  formatScore,
  formatSek,
  formatSignedSek,
  formatTime,
  scheduleWindows,
} from './format'
import { Unknown } from './Unknown'

type Detail = RouterOutputs['evCharging']['session']
type Counterfactual = NonNullable<Detail['economy']['counterfactual']>

// Status colours, computed as WCAG 2 contrast against --card from the oklch
// tokens in src/styles/app.css (light card oklch(1 0 0) / dark oklch(0.22 0 0)):
//   --success      light 3.40:1  dark 6.91:1
//   --warning      light 2.28:1  dark 8.52:1
//   --destructive  light 4.76:1  dark 5.99:1
// Coloured *text* needs 4.5:1, so only --destructive (both themes) and
// --success (dark only) colour a figure; everywhere else the text stays in
// foreground ink (≥ 16,5:1 light / ≥ 11,8:1 dark on every pill tint) and the
// colour sits on the icon or the pill's tint. Icons on their pill tint clear
// the 3:1 non-text minimum: success 3.05 / 5.92, destructive 3.99 / 5.25,
// warning 6.37 dark — light uses --warning-foreground (13.45:1), since
// --warning itself is ~2:1 there. The Direkt outline (--muted-foreground) is
// 4.73 / 6.68 on the card.

/** A session's summary: the cost, how good its timing was, and what charging at other times would have cost. */
export function SessionSummary({
  detail,
}: {
  detail: Pick<Detail, 'session' | 'economy' | 'optimalSchedule' | 'rateKw'>
}) {
  const { session, economy } = detail
  const cf = economy.counterfactual
  return (
    <div className="flex flex-col gap-3">
      <Card
        role="group"
        aria-label={m.charging_session_fig_actual()}
        className="@container gap-0 py-0"
      >
        <div className="flex flex-col gap-6 p-4 md:p-6">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <Hero detail={detail} />
            {cf ? <VerdictPill verdict={timingVerdict(cf.score)} /> : null}
          </div>
          {cf ? (
            <>
              <p className="max-w-prose text-pretty text-base">
                <Sentence cf={cf} />
              </p>
              {cf.score === null ? null : <RangeBar cf={cf} actualSek={economy.actual.totalSek} />}
              <div className="grid @lg:grid-cols-2 gap-x-8 gap-y-5 border-t pt-5">
                <SavedTile cf={cf} plugIn={session.startAt} rateKw={detail.rateKw} />
                <LeftTile
                  cf={cf}
                  windows={
                    detail.optimalSchedule
                      ? scheduleWindows(detail.optimalSchedule, session.startAt.getTime())
                      : null
                  }
                />
              </div>
            </>
          ) : null}
        </div>
      </Card>
      {economy.excluded ? (
        <Alert>
          <InfoIcon />
          <AlertDescription>
            {economy.excluded === 'no_hourly'
              ? m.charging_session_excluded_no_hourly()
              : m.charging_session_excluded_no_price()}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}

// The page's one hero figure. A partial cost (an excluded no_price session) is
// "—", never the partial kronor; a cost priced from the total alone is "≈".
function Hero({ detail }: { detail: Pick<Detail, 'session' | 'economy'> }) {
  const { session, economy } = detail
  const { actual } = economy
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="font-medium text-muted-foreground text-sm">
        {m.charging_session_fig_actual()}
      </span>
      {/* Proportional figures at display size: tabular digits look loose here. */}
      <span className="font-semibold text-4xl leading-tight tracking-tight md:text-5xl">
        {economy.actualComplete ? (
          <Estimated estimated={session.estimated}>{formatSek(actual.totalSek, 2)}</Estimated>
        ) : (
          <Unknown label={m.charging_sessions_cost_unknown()} />
        )}
      </span>
      {economy.actualComplete && actual.fullKwh > 0 ? (
        <span className="text-muted-foreground text-sm">
          {m.charging_session_kwh_unit_price({
            kwh: formatOneDecimal(session.kwh),
            price: formatKronor(actual.totalSek / actual.fullKwh, 2),
          })}
        </span>
      ) : null}
    </div>
  )
}

const VERDICT: Record<
  TimingVerdict,
  {
    label: () => string
    Icon: React.ComponentType<{ className?: string }>
    pill: string
    icon: string
  }
> = {
  good: {
    label: m.charging_session_verdict_good,
    Icon: CircleCheckIcon,
    pill: 'bg-success/10 ring-success/30',
    icon: 'text-success',
  },
  ok: {
    label: m.charging_session_verdict_ok,
    Icon: CircleMinusIcon,
    pill: 'bg-warning/15 ring-warning/40',
    icon: 'text-warning-foreground dark:text-warning',
  },
  poor: {
    label: m.charging_session_verdict_poor,
    Icon: TriangleAlertIcon,
    pill: 'bg-destructive/10 ring-destructive/30',
    icon: 'text-destructive',
  },
  none: {
    label: m.charging_session_verdict_none,
    Icon: CircleDashedIcon,
    pill: 'bg-muted ring-border',
    icon: 'text-muted-foreground',
  },
}

// Icon + label, never colour alone; the label stays in foreground ink.
function VerdictPill({ verdict }: { verdict: TimingVerdict }) {
  const { label, Icon, pill, icon } = VERDICT[verdict]
  return (
    <span
      data-verdict={verdict}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 font-medium text-foreground text-sm ring-1 ring-inset',
        pill,
      )}
    >
      <Icon aria-hidden="true" className={cn('size-4', icon)} />
      {label()}
    </span>
  )
}

function Sentence({ cf }: { cf: Counterfactual }) {
  const left = formatSek(cf.leftOnTableSek, 2)
  const saved = formatSek(cf.savedVsImmediateSek, 2)
  switch (summarySentence(cf)) {
    case 'no_choice':
      return m.charging_session_sentence_no_choice({
        spread: formatSek(cf.dearest.totalSek - cf.optimal.totalSek, 2),
      })
    case 'saved':
      return m.charging_session_sentence_saved({ left, saved })
    case 'lost':
      return m.charging_session_sentence_lost({
        left,
        lost: formatSek(-cf.savedVsImmediateSek, 2),
      })
    case 'like_immediate':
      return m.charging_session_sentence_like_immediate({ left })
    case 'near_optimal_saved':
      return m.charging_session_sentence_near_optimal_saved({ saved })
    case 'near_optimal_like_immediate':
      return m.charging_session_sentence_near_optimal_like_immediate()
  }
}

// Billigast → dyrast as a track, with where this session landed (solid) and
// where charging at once would have (outline). The two marker labels never
// share a row — "Faktiskt" above the track, "Direkt" below — so they can't
// collide at any width or distance, without measuring text. Each label is
// pinned to its marker by `left: p%` and shifted back by p% of its own width,
// so it stays inside the track at both ends.
function RangeBar({ cf, actualSek }: { cf: Counterfactual; actualSek: number }) {
  const cheapest = cf.optimal.totalSek
  const dearest = cf.dearest.totalSek
  const actual = rangePosition(actualSek, cheapest, dearest)
  const immediate = rangePosition(cf.immediate.totalSek, cheapest, dearest)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2 text-sm">
        <span className="font-medium text-muted-foreground">{m.charging_session_fig_score()}</span>
        <span className="font-semibold">{formatScore(cf.score)}</span>
      </div>
      <div
        role="img"
        aria-label={m.charging_session_range_label({
          actual: formatSek(actualSek, 2),
          immediate: formatSek(cf.immediate.totalSek, 2),
          cheapest: formatSek(cheapest, 2),
          dearest: formatSek(dearest, 2),
        })}
        className="flex flex-col gap-1 text-xs"
      >
        <MarkerLabel position={actual} className="font-medium text-foreground">
          {m.charging_session_range_actual()} {formatSek(actualSek, 2)}
        </MarkerLabel>
        <div className="relative h-6">
          {/* The tint only hints good → bad; the labels and markers carry the meaning. */}
          <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-linear-to-r from-success/30 via-warning/30 to-destructive/30" />
          <span
            data-marker="immediate"
            className="absolute top-0 h-6 w-3 -translate-x-1/2 rounded-sm border-2 border-muted-foreground bg-card"
            style={{ left: percent(immediate) }}
          />
          {/* Drawn last and narrower, so it stays visible inside the outline when the two coincide. */}
          <span
            data-marker="actual"
            className="absolute top-0 h-6 w-1 -translate-x-1/2 rounded-full bg-foreground"
            style={{ left: percent(actual) }}
          />
        </div>
        <MarkerLabel position={immediate} className="text-foreground">
          {m.charging_session_range_immediate()} {formatSek(cf.immediate.totalSek, 2)}
        </MarkerLabel>
        <div className="flex justify-between gap-4 pt-1 text-muted-foreground">
          <span>
            {m.charging_session_range_cheapest()} {formatSek(cheapest, 2)}
          </span>
          <span className="text-right">
            {m.charging_session_range_dearest()} {formatSek(dearest, 2)}
          </span>
        </div>
      </div>
    </div>
  )
}

const percent = (p: number) => `${Math.round(p * 1000) / 10}%`

function MarkerLabel({
  position,
  className,
  children,
}: {
  position: number
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className="relative h-4">
      <span
        className={cn('absolute top-0 whitespace-nowrap leading-4', className)}
        style={{ left: percent(position), transform: `translateX(-${percent(position)})` }}
      >
        {children}
      </span>
    </div>
  )
}

function DeltaTile({
  label,
  value,
  explainer,
}: {
  label: string
  value: React.ReactNode
  explainer: string | null
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a named stat tile, not a form's fieldset
    <div role="group" aria-label={label} className="flex flex-col gap-1">
      <span className="font-medium text-muted-foreground text-sm">{label}</span>
      <span className="flex items-center gap-1.5 font-semibold text-2xl tracking-tight">
        {value}
      </span>
      {explainer ? <p className="text-pretty text-muted-foreground text-sm">{explainer}</p> : null}
    </div>
  )
}

// Signed: green above zero, red below, neutral at zero (as rounded to öre).
function SavedTile({
  cf,
  plugIn,
  rateKw,
}: {
  cf: Counterfactual
  plugIn: Date
  rateKw: number | null
}) {
  const saved = cf.savedVsImmediateSek
  const sign = Math.round(saved * 100) === 0 ? 0 : Math.sign(saved)
  const Icon = sign > 0 ? ArrowUpIcon : sign < 0 ? ArrowDownIcon : MinusIcon
  return (
    <DeltaTile
      label={m.charging_session_saved_title()}
      value={
        <>
          <Icon
            aria-hidden="true"
            data-tone={sign > 0 ? 'good' : sign < 0 ? 'bad' : 'neutral'}
            className={cn(
              'size-5 shrink-0',
              sign > 0 ? 'text-success' : sign < 0 ? 'text-destructive' : 'text-muted-foreground',
            )}
          />
          <span className={cn(sign > 0 && 'dark:text-success', sign < 0 && 'text-destructive')}>
            {formatSignedSek(saved, 2)}
          </span>
        </>
      }
      explainer={
        rateKw === null
          ? null
          : m.charging_session_saved_explainer({
              time: formatTime(plugIn),
              rate: formatOneDecimal(rateKw),
            })
      }
    />
  )
}

// An opportunity, not a failure: neutral ink.
function LeftTile({ cf, windows }: { cf: Counterfactual; windows: string | null }) {
  return (
    <DeltaTile
      label={m.charging_session_left_title()}
      value={formatSek(cf.leftOnTableSek, 2)}
      explainer={windows === null ? null : m.charging_session_left_explainer({ windows })}
    />
  )
}
