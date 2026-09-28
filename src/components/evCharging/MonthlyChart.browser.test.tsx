import { expect, test, vi } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { MonthlyChart } from './MonthlyChart'

const months = Array.from({ length: 12 }, (_, i) => ({
  month: i + 1,
  kwh: 10 + i * 5,
  sessions: i + 1,
}))

test('renders one bar per month (12)', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} />
    </div>,
  )
  await vi.waitFor(() => {
    expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(12)
  })
})

test('labels the x-axis with localized short month names', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} />
    </div>,
  )
  // sv-SE short months ("jan.", "maj", "dec.").
  const jan = new Intl.DateTimeFormat('sv-SE', { month: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, 0, 15, 12)),
  )
  await expect.element(screen.getByText(jan)).toBeInTheDocument()
})
