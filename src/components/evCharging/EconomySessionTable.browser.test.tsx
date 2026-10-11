import { expect, test } from 'vitest'
import type { EconomyListRow } from '~/lib/evCharging/economy'
import { m } from '~/paraglide/messages'
import { renderWithRouter } from '~test/browser/render'
import { EconomySessionTable } from './EconomySessionTable'
import { formatDate, formatSek, formatTime } from './format'

// `over` may flip a row to excluded (excluded + counterfactual: null together).
const row = (over: Partial<EconomyListRow> = {}): EconomyListRow => ({
  sessionId: '11111111-1111-4111-8111-111111111111',
  startAt: new Date('2026-09-05T19:10:00Z'),
  endAt: new Date('2026-09-06T05:02:00Z'),
  kwh: 32.1,
  actualSek: 41.2,
  vehicle: 'ours',
  excluded: null,
  counterfactual: { score: 0.9, savedVsImmediateSek: 12.4, leftOnTableSek: 3.2, spreadSek: 32 },
  ...over,
})

const bodyRow = (screen: Awaited<ReturnType<typeof renderWithRouter>>['screen']) =>
  screen.getByRole('row').nth(1)

test('a comparable session shows cost, vs at once, left and timing', async () => {
  const { screen } = await renderWithRouter(<EconomySessionTable sessions={[row()]} />)
  const cells = bodyRow(screen).getByRole('cell')
  await expect.element(cells.nth(2)).toMatchTextContent(/^41,20\s?kr$/)
  await expect.element(cells.nth(3)).toMatchTextContent(/^12,40\s?kr$/)
  await expect.element(cells.nth(4)).toMatchTextContent(/^3,20\s?kr$/)
  await expect.element(cells.nth(5)).toMatchTextContent(/^90\s?%$/)
})

test('an excluded session shows its actual cost and the reason for the rest', async () => {
  const { screen } = await renderWithRouter(
    <EconomySessionTable sessions={[row({ excluded: 'no_price', counterfactual: null })]} />,
  )
  const cells = bodyRow(screen).getByRole('cell')
  await expect.element(cells.nth(2)).toMatchTextContent(/^41,20\s?kr$/)
  await expect.element(cells.nth(3)).toMatchTextContent(`— ${m.charging_economy_reason_no_price()}`)
})

test('an excluded session with a partial actual shows "—", not the partial kronor', async () => {
  const { screen } = await renderWithRouter(
    <EconomySessionTable
      sessions={[
        row({
          excluded: 'no_price',
          counterfactual: null,
          actualSek: null,
        }),
      ]}
    />,
  )
  const cells = bodyRow(screen).getByRole('cell')
  await expect.element(cells.nth(2)).toMatchTextContent(/^—/)
  expect(screen.getByText(/17,50/).elements()).toHaveLength(0)
})

test('an excluded no_hourly session names its reason', async () => {
  const { screen } = await renderWithRouter(
    <EconomySessionTable sessions={[row({ excluded: 'no_hourly', counterfactual: null })]} />,
  )
  await expect
    .element(bodyRow(screen).getByRole('cell').nth(3))
    .toMatchTextContent(`— ${m.charging_economy_reason_no_hourly()}`)
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
  await expect.element(cost(1)).toMatchTextContent(/^≈\s41,20\s?kr/)
  await expect.element(cost(1)).toMatchTextContent(m.charging_sessions_cost_estimated())
  for (const i of [2, 3]) {
    await expect.element(cost(i)).toMatchTextContent(/^41,20\s?kr$/)
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
  await expect.element(bodyRow(screen).getByRole('cell').nth(5)).toMatchTextContent(/^—/)
  // The sr-only reason names the spread that was too small (row()'s spread: 70 − 38 = 32 kr).
  await expect.element(bodyRow(screen).getByRole('cell').nth(5)).toMatchTextContent(
    new RegExp(
      m
        .charging_economy_tile_no_spread({ spread: formatSek(32, 2) })
        .replace(/[()]/g, '\\$&')
        .replace(/\s/g, '\\s'),
    ),
  )
})

test('on a phone a null-score row keeps the spread reason inside the folded line', async () => {
  const base = row()
  await renderWithRouter(
    <EconomySessionTable
      sessions={[
        row({ counterfactual: base.counterfactual && { ...base.counterfactual, score: null } }),
      ]}
    />,
  )
  // No Tailwind here, so the folded line is found by its `sm:hidden` class.
  const folded = document.querySelector('div.sm\\:hidden')
  expect(folded?.textContent).toContain(m.charging_economy_col_score())
  expect(folded?.textContent).toMatch(
    new RegExp(
      m
        .charging_economy_tile_no_spread({ spread: formatSek(32, 2) })
        .replace(/[()]/g, '\\$&')
        .replace(/\s/g, '\\s'),
    ),
  )
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

test('a guest session carries the Gäst badge; our own does not', async () => {
  const { screen } = await renderWithRouter(
    <EconomySessionTable
      sessions={[
        row(),
        row({ sessionId: '22222222-2222-4222-8222-222222222222', vehicle: 'other' }),
      ]}
    />,
  )
  await expect.element(screen.getByText(m.charging_vehicle_guest_badge())).toBeVisible()
  expect(screen.getByText(m.charging_vehicle_guest_badge()).elements()).toHaveLength(1)
})
