import { expect, test } from 'vitest'
import { userEvent } from 'vitest/browser'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { type Cost, TotalsTiles } from './TotalsTiles'

// No app.css in browser tests, so both layouts render: scope each assertion to one.
type Page = Awaited<ReturnType<typeof renderWithProviders>>['screen']
const grid = (page: Page) => page.getByTestId('totals-grid')

test('renders this month / this year / all time with kWh and session counts', async () => {
  const { screen: page } = await renderWithProviders(
    <TotalsTiles
      tiles={{
        thisMonth: { kwh: 42.25, sessions: 3 },
        thisYear: { kwh: 812.5, sessions: 51 },
        allTime: { kwh: 2345.04, sessions: 180 },
      }}
    />,
  )
  const screen = grid(page)
  await expect.element(screen.getByText(m.charging_tile_this_month())).toBeVisible()
  await expect.element(screen.getByText(m.charging_tile_this_year())).toBeVisible()
  await expect.element(screen.getByText(m.charging_tile_all_time())).toBeVisible()

  // sv-SE formatting: decimal comma, (narrow no-break) space as thousands separator.
  await expect.element(screen.getByText('42,3 kWh')).toBeVisible()
  await expect.element(screen.getByText('812,5 kWh')).toBeVisible()
  await expect.element(screen.getByText(/^2\s345,0 kWh$/)).toBeVisible()
  await expect.element(screen.getByText(m.charging_tile_sessions({ count: 51 }))).toBeVisible()
})

test('zero totals render as 0,0 kWh and 0 sessions', async () => {
  const zero = { kwh: 0, sessions: 0 }
  const { screen: page } = await renderWithProviders(
    <TotalsTiles tiles={{ thisMonth: zero, thisYear: zero, allTime: zero }} />,
  )
  const screen = grid(page)
  expect(screen.getByText('0,0 kWh').elements()).toHaveLength(3)
  expect(screen.getByText(m.charging_tile_sessions({ count: 0 })).elements()).toHaveLength(3)
})

test('session counts use the singular for one and group thousands', async () => {
  const { screen: page } = await renderWithProviders(
    <TotalsTiles
      tiles={{
        thisMonth: { kwh: 2, sessions: 1 },
        thisYear: { kwh: 12_345, sessions: 2 },
        allTime: { kwh: 12_345, sessions: 12_345 },
      }}
    />,
  )
  const screen = grid(page)
  await expect.element(screen.getByText('1 session', { exact: true })).toBeVisible()
  await expect.element(screen.getByText('2 sessioner', { exact: true })).toBeVisible()
  await expect.element(screen.getByText(/^12\s345 sessioner$/)).toBeVisible()
})

const zeroTiles = {
  thisMonth: { kwh: 100, sessions: 4 },
  thisYear: { kwh: 100, sessions: 4 },
  allTime: { kwh: 100, sessions: 4 },
}
const priced: Cost = {
  kwh: 100,
  gridKwh: 100,
  fullKwh: 100,
  noPriceKwh: 0,
  noTariffKwh: 0,
  solarKwh: 0,
  batteryKwh: 0,
  noHouseDataKwh: 0,
  solarValueSek: 0,
  solarPricedKwh: 0,
  solarUnpricedKwh: 0,
  spotSek: 62.9,
  feesSek: 96.2,
  totalSek: 159.1,
  avgOre: 159.1,
  complete: true,
}
const allTiles = (cost: Cost) => ({ thisMonth: cost, thisYear: cost, allTime: cost })

test('with cost, energy and cost are twin readouts, the average in the footer', async () => {
  const { screen: page } = await renderWithProviders(
    <TotalsTiles tiles={zeroTiles} cost={allTiles(priced)} />,
  )
  const screen = grid(page)
  expect(screen.getByText(m.charging_tile_energy(), { exact: true }).elements()).toHaveLength(3)
  expect(screen.getByText(m.charging_tile_cost(), { exact: true }).elements()).toHaveLength(3)
  expect(screen.getByText('100,0 kWh', { exact: true }).elements()).toHaveLength(3)
  expect(screen.getByText(/^159 kr$/).elements()).toHaveLength(3)
  await expect.element(screen.getByText(/^varav spotpris\s63\s?kr$/).first()).toBeVisible()
  await expect.element(screen.getByText('159 öre/kWh i snitt').first()).toBeVisible()
  expect(screen.getByText(m.charging_cost_min_prefix(), { exact: true }).elements()).toHaveLength(0)
})

test('the two readouts carry the same weight', async () => {
  const { screen: page } = await renderWithProviders(
    <TotalsTiles tiles={zeroTiles} cost={allTiles(priced)} />,
  )
  const screen = grid(page)
  const kwh = screen.getByText('100,0', { exact: true }).first().element()
  const kr = screen.getByText('159', { exact: true }).first().element()
  expect(kr.className).toBe(kwh.className)
})

test('a partly priced total is qualified "minst", with the missing share in the footer', async () => {
  const partial = { ...priced, fullKwh: 61, noPriceKwh: 39, complete: false }
  const { screen: page } = await renderWithProviders(
    <TotalsTiles tiles={zeroTiles} cost={allTiles(partial)} />,
  )
  const screen = grid(page)
  await expect.element(screen.getByText(/^minst 159 kr$/).first()).toBeVisible()
  await expect
    .element(screen.getByText(m.charging_cost_partial_hint({ share: '39 %' })).first())
    .toBeVisible()
  // The average covers priced energy only — it would contradict the kWh beside "minst".
  expect(screen.getByText(/öre\/kWh i snitt/).elements()).toHaveLength(0)
})

test('a missing tariff counts as missing too, and a sliver never rounds to 0 %', async () => {
  const partial = { ...priced, fullKwh: 99.8, noTariffKwh: 0.2, complete: false }
  const { screen: page } = await renderWithProviders(
    <TotalsTiles tiles={zeroTiles} cost={allTiles(partial)} />,
  )
  const screen = grid(page)
  await expect
    .element(screen.getByText(m.charging_cost_partial_hint({ share: '< 1 %' })).first())
    .toBeVisible()
})

test('an over-count is incomplete but never "minst" or a negative amount', async () => {
  const over = { ...priced, fullKwh: 100.5, complete: false }
  const { screen: page } = await renderWithProviders(
    <TotalsTiles tiles={zeroTiles} cost={allTiles(over)} />,
  )
  const screen = grid(page)
  expect(screen.getByText(/^159 kr$/).elements()).toHaveLength(3)
  await expect
    .element(screen.getByText(m.charging_cost_partial_hint_generic()).first())
    .toBeVisible()
  expect(screen.getByText(/-\d/).elements()).toHaveLength(0)
})

test('a tile with energy but no price shows "—" for cost with the reason, never 0 kr', async () => {
  const unpriced = {
    ...priced,
    fullKwh: 0,
    noPriceKwh: 100,
    spotSek: 0,
    feesSek: 0,
    totalSek: 0,
    avgOre: null,
    complete: false,
  }
  const { screen: page } = await renderWithProviders(
    <TotalsTiles
      tiles={zeroTiles}
      cost={{ thisMonth: unpriced, thisYear: priced, allTime: priced }}
    />,
  )
  const screen = grid(page)
  await expect.element(screen.getByText('—', { exact: true })).toBeVisible()
  await expect.element(screen.getByText(m.charging_cost_unknown(), { exact: true })).toBeVisible()
  await expect.element(screen.getByText(m.charging_cost_unknown_hint())).toBeVisible()
  expect(screen.getByText(/^0 kr$/).elements()).toHaveLength(0)
  expect(screen.getByText(/^159 kr$/).elements()).toHaveLength(2)
})

test('no energy is a true 0 kr, without a spot breakdown or footer', async () => {
  const none = { kwh: 0, sessions: 0 }
  const empty = {
    ...priced,
    kwh: 0,
    gridKwh: 0,
    fullKwh: 0,
    spotSek: 0,
    feesSek: 0,
    totalSek: 0,
    avgOre: null,
  }
  const { screen: page } = await renderWithProviders(
    <TotalsTiles
      tiles={{ thisMonth: none, thisYear: zeroTiles.thisYear, allTime: zeroTiles.allTime }}
      cost={{ thisMonth: empty, thisYear: priced, allTime: priced }}
    />,
  )
  const screen = grid(page)
  await expect.element(screen.getByText(/^0 kr$/)).toBeVisible()
  expect(screen.getByText(m.charging_cost_unknown(), { exact: false }).elements()).toHaveLength(0)
  expect(screen.getByText(/varav spotpris/).elements()).toHaveLength(2)
  expect(screen.getByText('159 öre/kWh i snitt').elements()).toHaveLength(2)
})

test('without cost a tile is the energy readout alone', async () => {
  const { screen: page } = await renderWithProviders(<TotalsTiles tiles={zeroTiles} />)
  const screen = grid(page)
  expect(screen.getByText(m.charging_tile_cost(), { exact: true }).elements()).toHaveLength(0)
  expect(screen.getByText('100,0 kWh', { exact: true }).elements()).toHaveLength(3)
})

// The narrow layout: one card, a segmented control picks the period.
const periods = {
  thisMonth: { kwh: 42.25, sessions: 3 },
  thisYear: { kwh: 812.5, sessions: 51 },
  allTime: { kwh: 2345.04, sessions: 180 },
}

test('the narrow card is a tab list of the three periods, this month first', async () => {
  const { screen: page } = await renderWithProviders(<TotalsTiles tiles={periods} />)
  const tabs = page.getByTestId('totals-tabs')
  await expect
    .element(tabs.getByRole('tablist', { name: m.charging_totals_heading() }))
    .toBeVisible()
  // The icons are decorative: each tab's name is its label alone.
  expect(
    tabs
      .getByRole('tab')
      .elements()
      .map((el) => el.textContent),
  ).toEqual([m.charging_tile_this_month(), m.charging_tile_this_year(), m.charging_tile_all_time()])
  await expect
    .element(tabs.getByRole('tab', { name: m.charging_tile_this_month() }))
    .toHaveAttribute('aria-selected', 'true')
  // Only the selected period's figures are in the card.
  await expect.element(tabs.getByRole('tabpanel').getByText('42,3 kWh')).toBeVisible()
  expect(tabs.getByText('812,5 kWh').elements()).toHaveLength(0)
})

test('picking a period swaps the card to its figures', async () => {
  const { screen: page } = await renderWithProviders(
    <TotalsTiles tiles={periods} cost={allTiles(priced)} />,
  )
  const tabs = page.getByTestId('totals-tabs')
  await tabs.getByRole('tab', { name: m.charging_tile_this_year() }).click()
  await expect
    .element(tabs.getByRole('tab', { name: m.charging_tile_this_year() }))
    .toHaveAttribute('aria-selected', 'true')
  await expect.element(tabs.getByRole('tabpanel').getByText('812,5 kWh')).toBeVisible()
  await expect.element(tabs.getByRole('tabpanel').getByText(/^159 kr$/)).toBeVisible()
  expect(tabs.getByText('42,3 kWh').elements()).toHaveLength(0)

  await tabs.getByRole('tab', { name: m.charging_tile_all_time() }).click()
  await expect.element(tabs.getByRole('tabpanel').getByText(/^2\s345,0 kWh$/)).toBeVisible()
})

test('arrow keys move between periods', async () => {
  const { screen: page } = await renderWithProviders(<TotalsTiles tiles={periods} />)
  const tabs = page.getByTestId('totals-tabs')
  await tabs.getByRole('tab', { name: m.charging_tile_this_month() }).click()
  await userEvent.keyboard('{ArrowRight}')
  await expect
    .element(tabs.getByRole('tab', { name: m.charging_tile_this_year() }))
    .toHaveAttribute('aria-selected', 'true')
  await expect.element(tabs.getByRole('tabpanel').getByText('812,5 kWh')).toBeVisible()
})
