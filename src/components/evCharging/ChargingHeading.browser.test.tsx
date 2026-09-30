import { expect, test } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { ChargingHeading } from './ChargingHeading'

test('shows the title, the noise-threshold note and when data last synced', async () => {
  const { screen } = await renderWithProviders(
    <ChargingHeading lastSuccessAt={new Date(Date.now() - 5 * 60_000)} />,
  )
  await expect.element(screen.getByRole('heading', { name: m.charging_title() })).toBeVisible()
  // NOISE_THRESHOLD_KWH = 0.5, formatted in the active (sv) locale.
  await expect
    .element(screen.getByText(m.charging_noise_note({ threshold: '0,5' }), { exact: false }))
    .toBeVisible()
  await expect
    .element(screen.getByText(m.charging_last_synced({ time: '' }), { exact: false }))
    .toBeVisible()
})

test('says "not synced yet" before the first successful sync', async () => {
  const { screen } = await renderWithProviders(<ChargingHeading lastSuccessAt={null} />)
  await expect.element(screen.getByText(m.charging_never_synced())).toBeVisible()
})

test('renders the action slot', async () => {
  const { screen } = await renderWithProviders(
    <ChargingHeading lastSuccessAt={null} action={<button type="button">act</button>} />,
  )
  await expect.element(screen.getByRole('button', { name: 'act' })).toBeVisible()
})

test('names the view when given a title', async () => {
  const { screen } = await renderWithProviders(
    <ChargingHeading title={m.charging_patterns_title()} lastSuccessAt={null} />,
  )
  await expect
    .element(screen.getByRole('heading', { level: 1, name: m.charging_patterns_title() }))
    .toBeVisible()
})
