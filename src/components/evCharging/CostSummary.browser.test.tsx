import { expect, test } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { type Cost, CostSummary } from './CostSummary'

const base: Cost = {
  kwh: 100,
  gridKwh: 100,
  fullKwh: 100,
  noPriceKwh: 0,
  noTariffKwh: 0,
  spotSek: 62.9,
  feesSek: 96.2,
  totalSek: 159.1,
  avgOre: 159.1,
  complete: true,
}

// sv-SE groups with a no-break space; match loosely.
const kr = (n: string) => new RegExp(`${n}\\s?kr`)

test('a complete total shows kronor incl VAT, the average and the spot share', async () => {
  const { screen } = await renderWithProviders(<CostSummary cost={base} />)
  await expect.element(screen.getByText(/159 kr inkl\. moms/)).toBeVisible()
  await expect.element(screen.getByText(/159 öre\/kWh i snitt/)).toBeVisible()
  await expect.element(screen.getByText(/varav spotpris 63 kr/)).toBeVisible()
  expect(screen.getByText(m.charging_cost_partial()).elements()).toHaveLength(0)
})

test('a partial total is badged and says how much energy lacks a price', async () => {
  const { screen } = await renderWithProviders(
    <CostSummary cost={{ ...base, fullKwh: 90, noPriceKwh: 10, complete: false }} />,
  )
  await expect.element(screen.getByText(m.charging_cost_partial())).toBeVisible()
  await expect
    .element(screen.getByText(m.charging_cost_partial_hint({ kwh: '10,0' })))
    .toBeVisible()
})

test('nothing priced says so instead of 0 kr', async () => {
  const { screen } = await renderWithProviders(
    <CostSummary
      cost={{
        ...base,
        fullKwh: 0,
        spotSek: 0,
        feesSek: 0,
        totalSek: 0,
        avgOre: null,
        complete: false,
      }}
    />,
  )
  await expect.element(screen.getByText(m.charging_cost_unknown())).toBeVisible()
  expect(screen.getByText(kr('0')).elements()).toHaveLength(0)
})

test('no energy shows no cost line at all', async () => {
  const { screen } = await renderWithProviders(
    <div data-testid="host">
      <CostSummary cost={{ ...base, kwh: 0, gridKwh: 0, fullKwh: 0, totalSek: 0, avgOre: null }} />
    </div>,
  )
  expect(screen.getByTestId('host').element().textContent).toBe('')
})
