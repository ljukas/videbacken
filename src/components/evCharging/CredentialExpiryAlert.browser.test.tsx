import { expect, test } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { CredentialExpiryAlert } from './CredentialExpiryAlert'

const expiresAt = new Date('2027-01-15T12:00:00.500Z')

test('warns with the date and days left', async () => {
  const { screen } = await renderWithProviders(
    <CredentialExpiryAlert expiry={{ expiresAt, daysLeft: 12, warn: true, expired: false }} />,
  )
  await expect.element(screen.getByRole('status')).toBeVisible()
  await expect.element(screen.getByText(/15 jan\. 2027/)).toBeVisible()
  await expect.element(screen.getByText(/om 12 dagar/)).toBeVisible()
})

test('uses the singular for one day left', async () => {
  const { screen } = await renderWithProviders(
    <CredentialExpiryAlert expiry={{ expiresAt, daysLeft: 1, warn: true, expired: false }} />,
  )
  await expect.element(screen.getByText(/om 1 dag\)/)).toBeVisible()
})

test('interrupts (role=alert, destructive) from 7 days, stays polite at 8', async () => {
  const urgent = await renderWithProviders(
    <CredentialExpiryAlert expiry={{ expiresAt, daysLeft: 7, warn: true, expired: false }} />,
  )
  const alert = urgent.screen.getByRole('alert')
  await expect.element(alert).toBeVisible()
  expect(alert.element().className).toContain('text-destructive')
  expect(urgent.screen.getByRole('status').elements()).toHaveLength(0)
  await urgent.screen.unmount()

  const calm = await renderWithProviders(
    <CredentialExpiryAlert expiry={{ expiresAt, daysLeft: 8, warn: true, expired: false }} />,
  )
  await expect.element(calm.screen.getByRole('status')).toBeVisible()
  expect(calm.screen.getByRole('alert').elements()).toHaveLength(0)
})

test('on the expiry day itself says today, urgently (role=alert)', async () => {
  const { screen } = await renderWithProviders(
    <CredentialExpiryAlert expiry={{ expiresAt, daysLeft: 0, warn: true, expired: false }} />,
  )
  const alert = screen.getByRole('alert')
  await expect.element(alert).toBeVisible()
  expect(alert.element().className).toContain('text-destructive')
  await expect.element(screen.getByText(/Den går ut i dag, 15 jan\. 2027\./)).toBeVisible()
  expect(screen.container.textContent).not.toMatch(/om 0 dag/)
})

test('renders nothing before the warning window, after expiry, or without an expiry', async () => {
  for (const expiry of [
    { expiresAt, daysLeft: 40, warn: false, expired: false },
    { expiresAt, daysLeft: 0, warn: true, expired: true },
    null,
  ]) {
    const { screen } = await renderWithProviders(<CredentialExpiryAlert expiry={expiry} />)
    expect(screen.container.textContent).toBe('')
    await screen.unmount()
  }
})
