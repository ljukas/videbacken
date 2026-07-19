import { expect, test } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { ClimateChart } from './ClimateChart'

test('renders a legend entry per device', async () => {
  const { screen } = await renderWithProviders(
    // A fixed-size wrapper so Recharts' ResponsiveContainer has a box to measure.
    <div style={{ width: 600, height: 300 }}>
      <ClimateChart
        rows={[
          { t: 1000, a: 20, b: 25 },
          { t: 2000, a: 21, b: 24 },
        ]}
        devices={[
          { id: 'a', displayName: 'NW corner' },
          { id: 'b', displayName: 'Kitchen' },
        ]}
        unit="°C"
        formatTick={(t) => new Date(t).toISOString()}
      />
    </div>,
  )
  await expect.element(screen.getByText('NW corner')).toBeVisible()
  await expect.element(screen.getByText('Kitchen')).toBeVisible()
})
