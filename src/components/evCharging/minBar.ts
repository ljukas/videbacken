// A bar whose value is real but tiny (a hundredth of a kWh, a 0.17 öre price)
// is a fraction of a pixel tall and reads as "nothing". Every bar chart gives
// real values this floor; a genuine "nothing happened" (0 kWh, a month without
// charging) and a missing value (null) stay empty. Recharts calls
// minPointSize(value, index) per bar — for stacked bars `value` is the stack's
// top, not the series' own value, so we look the series value up by index.
export const MIN_BAR_PX = 4

type MinPointSize = (value: number | null | undefined, index: number) => number

/** Floor for every non-null value; zero counts only when `zeroIsData` (a real 0 kr / 0 öre). */
export function minBarFor(
  values: readonly (number | null | undefined)[],
  { zeroIsData = false }: { zeroIsData?: boolean } = {},
): MinPointSize {
  return (_value, index) => {
    const v = values[index]
    return v == null || (v === 0 && !zeroIsData) ? 0 : MIN_BAR_PX
  }
}
