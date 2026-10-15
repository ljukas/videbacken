// Client-safe (heat pumps step 3): the day range rule of `heatPump.days` and a month's days, shared by the
// procedure and the page.

/** The longest range `heatPump.days` answers, in days (inclusive). */
export const HEAT_PUMP_DAYS_MAX = 800

/** The first and last Stockholm calendar day of `month` (1–12) of `year`, 'YYYY-MM-DD'. Calendar maths only. */
export function monthDays(year: number, month: number): { from: string; to: string } {
  const mm = String(month).padStart(2, '0')
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, '0')}` }
}
