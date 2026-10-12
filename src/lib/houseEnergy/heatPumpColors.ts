// Client-safe (heat pumps step 2, ADR-0027). A unit's colour is its place in the all-time unit order (name order), so
// it keeps its colour whatever a period or a year shows (data-viz: colour follows the entity, never its rank). Three
// validated tokens; a fourth unit gets no colour of its own (never cycled): neutral, its name carries identity.
export const HEAT_PUMP_COLORS = [
  'var(--energy-heat-pump-1)',
  'var(--energy-heat-pump-2)',
  'var(--energy-heat-pump-3)',
] as const

export function heatPumpColor(units: readonly { id: string }[], id: string): string {
  return HEAT_PUMP_COLORS[units.findIndex((u) => u.id === id)] ?? 'var(--muted-foreground)'
}
