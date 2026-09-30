import { expect, test } from 'vitest'
import { emptyTotals } from '~/lib/evCharging/cost'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithRouter } from '~test/browser/render'
import { EconomySessionTable } from './EconomySessionTable'
import { formatDate, formatTime } from './format'

type Row = RouterOutputs['evCharging']['economy']['sessions'][number]
const cost = (totalSek: number) => ({
  ...emptyTotals(),
  kwh: 10,
  gridKwh: 10,
  fullKwh: 10,
  totalSek,
})
// `over` may flip a row to excluded (excluded + counterfactual: null together), which
// Partial<union> can't express, hence the cast.
const row = (over: Partial<Row> = {}) =>
  ({
    sessionId: '11111111-1111-4111-8111-111111111111',
    startAt: new Date('2026-09-05T19:10:00Z'),
    endAt: new Date('2026-09-06T05:02:00Z'),
    kwh: 32.1,
    actual: cost(41.2),
    actualComplete: true,
    paidSpotOre: 40,
    windowAvgSpotOre: 55,
    excluded: null,
    counterfactual: {
      immediate: cost(53.6),
      optimal: cost(38),
      dearest: cost(70),
      score: 0.9,
      savedVsImmediateSek: 12.4,
      leftOnTableSek: 3.2,
    },
    ...over,
  }) as Row

const bodyRow = (screen: Awaited<ReturnType<typeof renderWithRouter>>['screen']) =>
  screen.getByRole('row').nth(1)

test('a comparable session shows cost, vs at once, left and timing', async () => {
  const { screen } = await renderWithRouter(<EconomySessionTable sessions={[row()]} />)
  const cells = bodyRow(screen).getByRole('cell')
  await expect.element(cells.nth(2)).toHaveTextContent(/^41,20\s?kr$/)
  await expect.element(cells.nth(3)).toHaveTextContent(/^12,40\s?kr$/)
  await expect.element(cells.nth(4)).toHaveTextContent(/^3,20\s?kr$/)
  await expect.element(cells.nth(5)).toHaveTextContent(/^90\s?%$/)
})

test('an excluded session shows its actual cost and the reason for the rest', async () => {
  const { screen } = await renderWithRouter(
    <EconomySessionTable sessions={[row({ excluded: 'no_price', counterfactual: null })]} />,
  )
  const cells = bodyRow(screen).getByRole('cell')
  await expect.element(cells.nth(2)).toHaveTextContent(/^41,20\s?kr$/)
  await expect.element(cells.nth(3)).toHaveTextContent(`— ${m.charging_economy_reason_no_price()}`)
})

test('an excluded session with a partial actual shows "—", not the partial kronor', async () => {
  const { screen } = await renderWithRouter(
    <EconomySessionTable
      sessions={[
        row({
          excluded: 'no_price',
          counterfactual: null,
          actualComplete: false,
          actual: cost(17.5),
        }),
      ]}
    />,
  )
  const cells = bodyRow(screen).getByRole('cell')
  await expect.element(cells.nth(2)).toHaveTextContent(/^—/)
  expect(screen.getByText(/17,50/).elements()).toHaveLength(0)
})

test('an excluded no_hourly session names its reason', async () => {
  const { screen } = await renderWithRouter(
    <EconomySessionTable sessions={[row({ excluded: 'no_hourly', counterfactual: null })]} />,
  )
  await expect
    .element(bodyRow(screen).getByRole('cell').nth(3))
    .toHaveTextContent(`— ${m.charging_economy_reason_no_hourly()}`)
})

test('a no_hourly (estimated) session marks its cost "≈"; other rows do not', async () => {
  const { screen } = await renderWithRouter(
    <EconomySessionTable
      sessions={[
        row({ excluded: 'no_hourly', counterfactual: null }),
        row({ sessionId: 'x', excluded: 'no_price', counterfactual: null }),
        row({ sessionId: 'y' }),
      ]}
    />,
  )
  const cost = (i: number) => screen.getByRole('row').nth(i).getByRole('cell').nth(2)
  await expect.element(cost(1)).toHaveTextContent(/^≈\s41,20\s?kr/)
  await expect.element(cost(1)).toHaveTextContent(m.charging_sessions_cost_estimated())
  for (const i of [2, 3]) {
    await expect.element(cost(i)).toHaveTextContent(/^41,20\s?kr$/)
  }
})

test('a flat-price session shows "—" for timing', async () => {
  const base = row()
  const { screen } = await renderWithRouter(
    <EconomySessionTable
      sessions={[
        row({ counterfactual: base.counterfactual && { ...base.counterfactual, score: null } }),
      ]}
    />,
  )
  await expect.element(bodyRow(screen).getByRole('cell').nth(5)).toHaveTextContent(/^—/)
})

// The browser-test env has no Tailwind, so the phone layout is pinned by its
// classes: the comparison headers hide below `sm` and the comparison repeats
// under the date (or the reason, for an excluded row).
test('on a phone the comparison columns fold under the date', async () => {
  const { screen } = await renderWithRouter(
    <EconomySessionTable
      sessions={[row(), row({ sessionId: 'x', excluded: 'no_price', counterfactual: null })]}
    />,
  )
  const tokens = (el: Element) => ({
    hidden: el.classList.contains('hidden'),
    smCell: el.classList.contains('sm:table-cell'),
  })
  for (const name of [
    m.charging_economy_col_vs_immediate(),
    m.charging_economy_col_left(),
    m.charging_economy_col_score(),
  ]) {
    const header = screen.getByText(name, { exact: true }).element()
    expect(tokens(header)).toEqual({ hidden: true, smCell: true })
  }
  const cells = (i: number) => screen.getByRole('row').nth(i).getByRole('cell')
  for (const n of [3, 4, 5]) {
    expect(tokens(cells(1).nth(n).element())).toEqual({ hidden: true, smCell: true })
  }
  expect(tokens(cells(2).nth(3).element())).toEqual({ hidden: true, smCell: true })
  const folded = (i: number) => cells(i).first().element().querySelector('.sm\\:hidden')
  expect(folded(1)?.textContent).toMatch(
    new RegExp(
      `${m.charging_economy_col_vs_immediate()} 12,40\\s?kr ${m.charging_economy_col_left()} 3,20\\s?kr ${m.charging_economy_col_score()} 90\\s?%`,
    ),
  )
  expect(folded(2)?.textContent).toBe(m.charging_economy_reason_no_price())
})

test('the date links to the session page', async () => {
  const { screen } = await renderWithRouter(<EconomySessionTable sessions={[row()]} />)
  const { startAt } = row()
  const link = screen.getByRole('link', {
    name: m.charging_session_link_label({
      date: formatDate(startAt),
      time: formatTime(startAt),
    }),
  })
  await expect
    .element(link)
    .toHaveAttribute('href', '/charging/sessions/11111111-1111-4111-8111-111111111111')
})
