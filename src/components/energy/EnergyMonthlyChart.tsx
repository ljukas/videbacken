import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  DefaultZIndexes,
  type PlotArea,
  ReferenceArea,
  ReferenceLine,
  useActiveTooltipLabel,
  usePlotArea,
  XAxis,
  YAxis,
  ZIndexLayer,
} from 'recharts'
import { CHART_HEIGHT, ChartFrame, TooltipRow } from '~/components/evCharging/ChartFrame'
import {
  formatCount,
  formatOneDecimal,
  formatShare,
  monthLabel,
  monthName,
} from '~/components/evCharging/format'
import type { MetricOption } from '~/components/evCharging/MetricToggle'
import {
  type ChartConfig,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
} from '~/components/ui/chart'
import { energyFigures, gapHours, type PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import {
  type ChartRow,
  chartRows,
  type EnergyMetric,
  energyTooltipRows,
  isBelowAxis,
  METRIC_SERIES,
  type SeriesKey,
} from './energyTooltip'

export type { EnergyMetric } from './energyTooltip'

export function energyMetricOptions(): MetricOption<EnergyMetric>[] {
  return [
    { value: 'solar', label: m.energy_metric_solar() },
    { value: 'grid', label: m.energy_metric_grid() },
    { value: 'load', label: m.energy_metric_load() },
  ]
}

function seriesConfig(): Record<SeriesKey, { label: string; color: string }> {
  return {
    solarDirect: { label: m.energy_series_solar_direct(), color: 'var(--energy-solar)' },
    solarBattery: { label: m.energy_series_solar_battery(), color: 'var(--energy-battery)' },
    solarExported: { label: m.energy_series_solar_exported(), color: 'var(--energy-export)' },
    importDirect: { label: m.energy_series_import_direct(), color: 'var(--energy-grid)' },
    importBattery: { label: m.energy_series_import_battery(), color: 'var(--energy-battery)' },
    exported: { label: m.energy_series_export(), color: 'var(--energy-export)' },
    car: { label: m.energy_series_car(), color: 'var(--energy-car)' },
    house: { label: m.energy_series_house(), color: 'var(--energy-house)' },
  }
}

const seriesOrder = (metric: EnergyMetric) => (item: { dataKey?: unknown }) =>
  METRIC_SERIES[metric].indexOf(item.dataKey as SeriesKey)

const TOTAL_LABEL: Record<EnergyMetric, () => string> = {
  solar: m.energy_chart_total_solar,
  grid: m.energy_chart_total_grid,
  load: m.energy_chart_total_load,
}

type Row = ChartRow & { label: string }

/** The x-axis band under the plot (the month labels); the hover outline reaches down over it. */
const TICK_BAND = 30
/** Below this column width the month labels shorten to initials. */
const NARROW_COLUMN = 36

/** How the chart was last used: touch taps select without a tooltip or an outline. */
type Modality = 'mouse' | 'pen' | 'touch' | 'keyboard'

// The hovered (or keyboard-focused) month: an outline round the whole column,
// its label included (the tick band below the plot). Drawn in a layer above
// the bars (Recharts' own cursor sits below them), inset so it never clips at
// the chart's edges. A month without readings gets a dashed, muted outline,
// and only from the keyboard (so focus stays visible); none on touch.
// The x axis is a band scale without padding: month i spans width / 12.
function MonthOutline({ data, modality }: { data: Row[]; modality: Modality }) {
  const label = useActiveTooltipLabel()
  const area = usePlotArea()
  if (!area || label === undefined || modality === 'touch') return null
  const i = data.findIndex((r) => r.label === String(label))
  if (i < 0) return null
  const empty = !data[i].sums
  if (empty && modality !== 'keyboard') return null
  const band = area.width / data.length
  return (
    <ZIndexLayer zIndex={DefaultZIndexes.cursorLine}>
      <rect
        data-slot="hover-month"
        x={area.x + i * band + 2}
        y={area.y - 4}
        width={Math.max(0, band - 4)}
        height={area.height + 4 + TICK_BAND}
        rx={6}
        fill="none"
        stroke="var(--muted-foreground)"
        strokeWidth={1.5}
        strokeDasharray={empty ? '4 3' : undefined}
        strokeOpacity={empty ? 0.6 : 1}
        pointerEvents="none"
      />
    </ZIndexLayer>
  )
}

// Reads the chart's state for the handlers outside it: the month the pointer
// or the keyboard is on (null: none, or a month without readings) for Enter
// and the pointer cursor, and the plot area for mapping a click to a month.
function ChartProbe({
  data,
  onActiveMonth,
  plotArea,
}: {
  data: Row[]
  onActiveMonth: (month: number | null) => void
  plotArea: RefObject<PlotArea | undefined>
}) {
  const label = useActiveTooltipLabel()
  const area = usePlotArea()
  const row = label === undefined ? undefined : data.find((r) => r.label === String(label))
  const month = row?.sums ? row.month : null
  useEffect(() => {
    onActiveMonth(month)
  }, [month, onActiveMonth])
  useEffect(() => {
    plotArea.current = area
  }, [area, plotArea])
  return null
}

// A month label: bold and foreground when selected; initials when the columns
// are narrower than NARROW_COLUMN. The fill is an inline style so it wins over
// ChartContainer's tick-text fill class.
function MonthTick(props: {
  x?: number
  y?: number
  payload?: { value: string }
  selectedLabel?: string
}) {
  const plotWidth = usePlotArea()?.width ?? 0
  const { x = 0, y = 0, payload, selectedLabel } = props
  if (!payload) return null
  const narrow = plotWidth / 12 < NARROW_COLUMN
  const selected = payload.value === selectedLabel
  return (
    <text
      x={x}
      y={y}
      dy="0.71em"
      textAnchor="middle"
      fontSize={13}
      fontWeight={selected ? 600 : 400}
      style={{ fill: selected ? 'var(--foreground)' : 'var(--muted-foreground)' }}
    >
      {narrow ? payload.value.charAt(0).toUpperCase() : payload.value}
    </text>
  )
}

// The house's energy per month of `year` for one metric: stacked bars, export
// below the axis on Nät, a legend (touch can't hover), and a tooltip with the
// month's parts (kWh and share), its total and any gap. Months without data
// draw no bar (never a zero bar) and can't be selected. Clicking a month (or
// Enter / Space on the keyboard-focused one) selects it; the selected month is
// tinted with a bold label. The page owns the metric, the year and the selection.
export function EnergyMonthlyChart({
  year,
  months,
  metric,
  currentMonth,
  selectedMonth,
  onSelectMonth,
}: {
  year: number
  months: (PeriodSums | null)[]
  metric: EnergyMetric
  /** The current Stockholm month when `year` is the current year (its tooltip says "hittills"), else null. */
  currentMonth: number | null
  /** The month (1–12) of `year` shown in the summary, else null. */
  selectedMonth: number | null
  onSelectMonth: (month: number) => void
}) {
  // The active month lives in a ref (read on Enter) plus a data attribute (the
  // pointer cursor): hovering never re-renders the chart.
  const wrapper = useRef<HTMLDivElement>(null)
  const activeMonth = useRef<number | null>(null)
  const plotArea = useRef<PlotArea | undefined>(undefined)
  // Changes only when the input switches (setState bails out on the same value).
  const [modality, setModality] = useState<Modality>('mouse')
  const onPointer = (e: React.PointerEvent) =>
    setModality(e.pointerType === 'touch' ? 'touch' : e.pointerType === 'pen' ? 'pen' : 'mouse')
  const setActiveMonth = useCallback((month: number | null) => {
    activeMonth.current = month
    wrapper.current?.toggleAttribute('data-selectable', month !== null)
  }, [])

  if (months.every((p) => p === null)) {
    return (
      <div>
        <div
          className="flex items-center justify-center rounded-lg border px-4 text-center text-muted-foreground text-sm"
          style={{ height: CHART_HEIGHT }}
        >
          {m.energy_chart_no_data({ year: String(year) })}
        </div>
        {/* The hint's line, reserved: the card is as tall as with data (the
            legend sits inside CHART_HEIGHT). */}
        <p aria-hidden className="invisible mt-2 text-muted-foreground text-sm">
          {m.energy_chart_select_hint()}
        </p>
      </div>
    )
  }
  const series = METRIC_SERIES[metric]
  const all = seriesConfig()
  const config = Object.fromEntries(series.map((k) => [k, all[k]])) satisfies ChartConfig
  const data: Row[] = chartRows(metric, months).map((r) => ({ ...r, label: monthLabel(r.month) }))
  const top = series[series.length - (metric === 'grid' ? 2 : 1)]
  const selectedLabel = selectedMonth === null ? undefined : monthLabel(selectedMonth)
  // A click (or a tap) on a month's column, its label included, selects it.
  // Mapped from the pointer position, not Recharts' click state: that follows
  // the frame-throttled hover, so a tap lands before it and reads the last month.
  const selectAt = (e: React.MouseEvent<HTMLDivElement>) => {
    const area = plotArea.current
    const svg = e.currentTarget.querySelector('.recharts-surface')
    if (!area || !svg) return
    const box = svg.getBoundingClientRect()
    const px = e.clientX - box.left - area.x
    const py = e.clientY - box.top - area.y
    if (px < 0 || px >= area.width || py < 0 || py > area.height + TICK_BAND) return
    const row = data[Math.floor((px / area.width) * data.length)]
    if (row?.sums) onSelectMonth(row.month)
  }

  return (
    <div>
      {/* Clicks and Enter / Space select a month. The keys are captured here
          so Recharts' own Enter (which toggles the tooltip off) doesn't run.
          A pointer press doesn't focus the chart: focus would put Recharts in
          keyboard mode on January, left showing once the pointer leaves. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: delegates for the chart's focusable svg (role="application"); its keyboard path is onKeyDownCapture */}
      <div
        ref={wrapper}
        className="[&[data-selectable]_.recharts-surface]:cursor-pointer [&_.recharts-surface:focus-visible]:[outline-offset:2px] [&_.recharts-surface:focus-visible]:[outline:2px_solid_var(--ring)] [&_.recharts-surface]:rounded-md"
        onClick={selectAt}
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={onPointer}
        onPointerMove={onPointer}
        onFocus={() => setModality('keyboard')}
        onKeyDownCapture={(e) => {
          setModality('keyboard')
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          e.stopPropagation()
          if (activeMonth.current !== null) onSelectMonth(activeMonth.current)
        }}
      >
        <ChartFrame config={config} className="text-[13px] [&_.recharts-legend-wrapper]:text-sm">
          <BarChart
            data={data}
            stackOffset={metric === 'grid' ? 'sign' : 'none'}
            margin={{ left: 4, right: 12, top: 8, bottom: 0 }}
          >
            <CartesianGrid vertical={false} />
            {selectedLabel ? (
              <ReferenceArea
                data-slot="selected-month"
                x1={selectedLabel}
                x2={selectedLabel}
                fill="var(--brand)"
                fillOpacity={0.12}
                strokeOpacity={0}
                ifOverflow="visible"
              />
            ) : null}
            <XAxis
              dataKey="label"
              tickLine={false}
              tickMargin={8}
              height={TICK_BAND}
              interval={0}
              tick={<MonthTick selectedLabel={selectedLabel} />}
            />
            <YAxis
              width="auto"
              tickLine={false}
              tickMargin={4}
              allowDecimals={false}
              tickFormatter={(v) => formatCount(Number(v))}
            />
            {metric === 'grid' ? <ReferenceLine y={0} stroke="var(--border)" /> : null}
            <ChartTooltip
              cursor={false}
              content={({ active, payload }) => (
                <EnergyTooltip
                  active={active && modality !== 'touch'}
                  row={payload?.[0]?.payload as Row | undefined}
                  metric={metric}
                  currentMonth={currentMonth}
                />
              )}
            />
            <ChartProbe data={data} onActiveMonth={setActiveMonth} plotArea={plotArea} />
            <MonthOutline data={data} modality={modality} />
            <ChartLegend
              itemSorter={seriesOrder(metric)}
              content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />}
            />
            {series.map((key) => (
              <Bar
                key={key}
                dataKey={key}
                stackId="kwh"
                fill={`var(--color-${key})`}
                radius={isBelowAxis(metric, key) ? [0, 0, 2, 2] : key === top ? [2, 2, 0, 0] : 0}
                // A 2 px surface gap between stacked segments.
                stroke="var(--card)"
                strokeWidth={2}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ChartFrame>
      </div>
      <p className="mt-2 text-muted-foreground text-sm">{m.energy_chart_select_hint()}</p>
    </div>
  )
}

function EnergyTooltip({
  active,
  row,
  metric,
  currentMonth,
}: {
  active?: boolean
  row: Row | undefined
  metric: EnergyMetric
  currentMonth: number | null
}) {
  if (!active || !row?.sums) return null
  const { parts, totalKwh } = energyTooltipRows(metric, row.sums)
  const gap = gapHours(energyFigures(row.sums))
  const config = seriesConfig()
  // Nät's export is a separate flow: it follows the total instead of adding to it.
  const stacked = parts.filter((p) => !isBelowAxis(metric, p.key))
  const after = parts.filter((p) => isBelowAxis(metric, p.key))
  // Rows without a share keep the (empty) share column so the kWh figures line up.
  const rowFor = ({ key, kwh, share }: (typeof parts)[number]) => (
    <TooltipRow
      key={key}
      label={config[key].label}
      color={config[key].color}
      share={share === null ? '' : formatShare(share)}
    >
      {formatOneDecimal(kwh)} kWh
    </TooltipRow>
  )
  return (
    <div className="grid min-w-56 gap-1 rounded-lg border bg-background px-3 py-2 text-sm shadow-xl">
      <div className="font-semibold text-sm">
        {monthName(row.month)}
        {row.month === currentMonth ? ` (${m.energy_chart_so_far()})` : ''}
      </div>
      {stacked.map(rowFor)}
      <TooltipRow label={TOTAL_LABEL[metric]()} strong share="">
        {formatOneDecimal(totalKwh)} kWh
      </TooltipRow>
      {after.map(rowFor)}
      {gap === null ? null : (
        <span className="text-muted-foreground">
          {m.energy_missing_hours({ hours: String(gap) })}
        </span>
      )}
    </div>
  )
}
