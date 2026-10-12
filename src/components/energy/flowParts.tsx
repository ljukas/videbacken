import type { LucideIcon } from 'lucide-react'
import type * as React from 'react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { formatShare, formatSignedOneDecimal } from '~/components/evCharging/format'
import { Switch } from '~/components/ui/switch'
import type { EnergyFigures, PeriodSums } from '~/lib/houseEnergy/figures'
import type { FlowNode, NodeText } from '~/lib/houseEnergy/flowLayout'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

// The drawing parts the Energi flow diagrams share (Översikt's and the battery's): node frame, value pill, fitted
// figure size, the self-sufficiency-style ring, the values switch and the table frame. Geometry is flowLayout.ts.
export const NODE_SURFACE = 'color-mix(in oklab, var(--foreground) 3%, var(--card))'
// The muted token reaches only 4.4:1 on the raised node surface in light; a touch of the foreground lifts the
// node's secondary text (unit, "Förlust", "Lager", car lines) above 4.5:1 in both themes.
export const NODE_MUTED = {
  fill: 'color-mix(in oklab, var(--muted-foreground) 90%, var(--foreground))',
}
/** "Ändrat lager": the signed change in stored energy, "—" when the charge level is unknown (the figure is then 0). */
export function storedText(s: PeriodSums, f: EnergyFigures): string {
  return s.firstSocPct !== null && s.lastSocPct !== null
    ? `${formatSignedOneDecimal(f.deltaStored)}\u00a0kWh`
    : '—'
}

// A value on an arrow: the pill is measured from the text, before paint.
export function ValuePill({
  x,
  y,
  text,
  className,
}: {
  x: number
  y: number
  text: string
  className?: string
}) {
  const ref = useRef<SVGTextElement>(null)
  const [box, setBox] = useState<{ x: number; y: number; width: number; height: number } | null>(
    null,
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: text and position are the re-measure triggers
  useLayoutEffect(() => {
    let live = true
    const measure = () => {
      const b = ref.current?.getBBox()
      if (live && b) setBox({ x: b.x, y: b.y, width: b.width, height: b.height })
    }
    measure()
    // The body font swaps in after first paint and changes the text width: measure again once it has.
    document.fonts?.ready.then(measure)
    return () => {
      live = false
    }
  }, [text, x, y])
  return (
    <g data-slot="flow-value" pointerEvents="none" className={className}>
      {box ? (
        <rect
          x={box.x - 7}
          y={box.y - 3}
          width={box.width + 14}
          height={box.height + 6}
          rx={6}
          className="fill-card stroke-border"
        />
      ) : null}
      <text
        ref={ref}
        x={x}
        y={y + 5}
        textAnchor="middle"
        fontSize={14}
        fontWeight={600}
        className="fill-foreground tabular-nums"
      >
        {text}
      </text>
    </g>
  )
}

/** True once the body font has loaded (it changes text widths after first paint). */
export function useFontsReady(): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let live = true
    document.fonts?.ready.then(() => {
      if (live) setReady(true)
    })
    return () => {
      live = false
    }
  }, [])
  return ready
}

/**
 * The font size that lets a node's figure (or the battery's loss) fit its `room`: from `size`, 2 px down at a
 * time to `minSize`, measured before paint and again once the body font has loaded. Only the size changes; the
 * baseline stays, so nothing moves.
 */
export function useFittedSize(
  ref: React.RefObject<SVGTextElement | null>,
  text: string,
  { x, size: base, minSize, room }: { x: number; size: number; minSize: number; room: number },
) {
  const fontsLoaded = useFontsReady()
  // A new text, room or font starts again from the full size.
  const key = `${text}|${base}|${room}|${fontsLoaded}`
  const [fit, setFit] = useState({ key, size: base })
  const size = fit.key === key ? fit.size : base
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || size <= minSize) return
    const b = el.getBBox()
    if (b.x + b.width > x + room) setFit({ key, size: Math.max(minSize, size - 2) })
  }, [ref, key, size, minSize, room, x])
  return size
}

/** `text` cut to its first `length` characters and "…" (at least one character); the whole text at full length. */
function cutText(text: string, length: number): string {
  return length >= text.length ? text : `${text.slice(0, Math.max(1, length)).trimEnd()}…`
}

/**
 * The longest cut of `text` (in characters) that ends within `right`, found by a binary search that writes each
 * candidate into `el`'s text node and measures it, then puts the shown text back: one layout pass, however long.
 */
function fittedLength(el: SVGTextElement, text: string, right: number): number {
  const node = el.firstChild
  if (!(node instanceof Text)) return text.length
  const shown = node.data
  const fits = (s: string) => {
    node.data = s
    const b = el.getBBox()
    return b.x + b.width <= right
  }
  try {
    if (fits(text)) return text.length
    // The largest length whose cut fits; 1 when none does (the name's first character and "…").
    let lo = 1
    let hi = text.length - 1
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (fits(cutText(text, mid))) lo = mid
      else hi = mid - 1
    }
    return lo
  } finally {
    node.data = shown
  }
}

/**
 * `text`, cut with "…" until it fits `room` px from `x` (a user-set name on a node; Comfort Cloud allows 200
 * characters), measured before paint in one pass and again once the body font has loaded. The full text stays in the
 * tooltip and the table.
 */
export function useFittedText(
  ref: React.RefObject<SVGTextElement | null>,
  text: string,
  x: number,
  room: number,
): string {
  const fontsLoaded = useFontsReady()
  // A new text, place, room or font shows the whole text again and measures it.
  const key = `${text}|${x}|${room}|${fontsLoaded}`
  const [fit, setFit] = useState<{ key: string; length: number } | null>(null)
  const measured = fit?.key === key
  const shown = cutText(text, measured ? fit.length : text.length)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || measured) return
    setFit({ key, length: fittedLength(el, text, x + room) })
  }, [ref, key, measured, text, x, room])
  return shown
}

/** A node's box, icon tile, icon and label; the node's figures follow as children. */
export function NodeFrame({
  node: n,
  tile,
  label,
  labelText,
  labelRef,
  Icon,
  tint,
  children,
  ...rest
}: {
  node: FlowNode
  tile: NodeText['tile']
  label: { x: number; y: number }
  labelText: string
  labelRef?: React.Ref<SVGTextElement>
  Icon: LucideIcon
  /** The arrow colour the tile is tinted with (sources); neutral without. */
  tint?: string
  children?: React.ReactNode
} & React.SVGProps<SVGGElement>) {
  return (
    <g {...rest}>
      <rect
        x={n.x - n.w / 2}
        y={n.y - n.h / 2}
        width={n.w}
        height={n.h}
        rx={12}
        className="stroke-border"
        style={{ fill: NODE_SURFACE }}
      />
      <rect
        x={tile.x}
        y={tile.y}
        width={tile.size}
        height={tile.size}
        rx={tile.size * 0.24}
        style={{
          fill: tint
            ? `color-mix(in oklab, ${tint} 24%, ${NODE_SURFACE})`
            : 'color-mix(in oklab, var(--foreground) 7%, var(--card))',
        }}
      />
      <Icon
        aria-hidden
        x={tile.x + (tile.size - tile.icon) / 2}
        y={tile.y + (tile.size - tile.icon) / 2}
        width={tile.icon}
        height={tile.icon}
        className="text-foreground"
      />
      <text
        ref={labelRef}
        x={label.x}
        y={label.y}
        fontSize={14}
        fontWeight={500}
        className="fill-foreground"
      >
        {labelText}
      </text>
      {children}
    </g>
  )
}

export function RingFigure({
  value,
  valueText = value === null ? '—' : formatShare(value),
  label,
  detail,
  arcClassName,
  hidden,
}: {
  value: number | null
  valueText?: string
  label: string
  detail: string
  arcClassName: string
  hidden: boolean
}) {
  const r = 18
  const circ = 2 * Math.PI * r
  return (
    // Invisible (not absent) without figures, so the card is as tall for every period.
    <div
      data-slot="ring-figure"
      className={hidden ? 'invisible flex items-center gap-3' : 'flex items-center gap-3'}
      aria-hidden={hidden || undefined}
    >
      <svg viewBox="0 0 44 44" className="size-11 shrink-0" aria-hidden="true">
        <circle cx={22} cy={22} r={r} fill="none" strokeWidth={6} className="stroke-muted" />
        {value !== null ? (
          <circle
            data-slot="ring-arc"
            cx={22}
            cy={22}
            r={r}
            fill="none"
            strokeWidth={6}
            className={arcClassName}
            strokeDasharray={`${circ * value} ${circ}`}
            transform="rotate(-90 22 22)"
          />
        ) : null}
      </svg>
      <div className="flex flex-col">
        <span className="font-medium text-sm">{label}</span>
        <span className="font-semibold text-[length:24px] tabular-nums leading-tight @[860px]:text-[length:28px]">
          {valueText}
        </span>
        <span className="text-muted-foreground text-sm">{detail}</span>
      </div>
    </div>
  )
}

export function FlowValuesSwitch({
  checked,
  onCheckedChange,
  hint,
  switchClassName,
}: {
  checked: boolean
  onCheckedChange: (on: boolean) => void
  hint: string
  switchClassName?: string
}) {
  const switchId = useId()
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <p className="text-muted-foreground text-sm">{hint}</p>
      <label
        htmlFor={switchId}
        className={cn('flex min-h-10 cursor-pointer items-center gap-2.5 text-sm', switchClassName)}
      >
        <Switch id={switchId} checked={checked} onCheckedChange={onCheckedChange} />
        {m.energy_flow_show_values()}
      </label>
    </div>
  )
}

/** The Flöde / Värde table (or `columns`): `rows` first (the first cell names the row), then `children`. */
export function FlowTableFrame({
  columns = [m.energy_flow_table_flow(), m.energy_flow_table_value()],
  rows,
  children,
}: {
  columns?: string[]
  rows: string[][]
  children?: React.ReactNode
}) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="min-w-full border-collapse">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            {columns.map((c, i) => (
              <th
                key={c}
                scope="col"
                className={
                  i === 0 ? 'py-1.5 pr-4 font-medium' : 'py-1.5 pl-4 text-right font-medium'
                }
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, ...values]) => (
            <tr key={name} className="border-b">
              <th scope="row" className="py-1.5 pr-4 text-left font-normal">
                {name}
              </th>
              {values.map((v, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a row's cells are positional
                <td key={i} className="py-1.5 pl-4 text-right tabular-nums">
                  {v}
                </td>
              ))}
            </tr>
          ))}
          {children}
        </tbody>
      </table>
    </div>
  )
}
