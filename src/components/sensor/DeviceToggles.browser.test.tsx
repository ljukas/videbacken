import { expect, test, vi } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { DeviceToggles } from './DeviceToggles'

const devices = [
  { id: 'a', displayName: 'NW corner', color: 'var(--chart-1)' },
  { id: 'b', displayName: 'Kitchen', color: 'var(--chart-2)' },
]

test('reflects visibility via aria-pressed and toggles on click', async () => {
  const onToggle = vi.fn()
  const { screen } = await renderWithProviders(
    <DeviceToggles devices={devices} hidden={new Set(['b'])} onToggle={onToggle} />,
  )

  const nw = screen.getByRole('button', { name: 'NW corner' })
  const kitchen = screen.getByRole('button', { name: 'Kitchen' })
  await expect.element(nw).toHaveAttribute('aria-pressed', 'true') // visible
  await expect.element(kitchen).toHaveAttribute('aria-pressed', 'false') // hidden

  await nw.click()
  expect(onToggle).toHaveBeenCalledWith('a')
})

test('chips are 40 px tall with 14 px text and stay listed when hidden', async () => {
  const { screen } = await renderWithProviders(
    <DeviceToggles devices={devices} hidden={new Set(['a', 'b'])} onToggle={() => {}} />,
  )
  for (const name of ['NW corner', 'Kitchen']) {
    const chip = screen.getByRole('button', { name })
    await expect.element(chip).toHaveAttribute('aria-pressed', 'false')
    expect(chip.element().className).toContain('h-10')
    expect(chip.element().className).toContain('text-sm')
  }
})
