import { expect, test } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { CredentialExpiryAlert } from './CredentialExpiryAlert'

const expiresAt = new Date('2027-01-15T12:00:00.500Z')

test('warns with the date and days left', async () => {
  const { screen } = await renderWithProviders(
    <CredentialExpiryAlert expiry={{ expiresAt, daysLeft: 12, warn: true }} />,
  )
  await expect.element(screen.getByRole('status')).toBeVisible()
  await expect.element(screen.getByText(/15 jan\. 2027/)).toBeVisible()
  await expect.element(screen.getByText(/om 12 dagar/)).toBeVisible()
})

test('renders nothing before the warning window, after expiry, or without an expiry', async () => {
  for (const expiry of [
    { expiresAt, daysLeft: 40, warn: false },
    { expiresAt, daysLeft: 0, warn: true },
    null,
  ]) {
    const { screen } = await renderWithProviders(<CredentialExpiryAlert expiry={expiry} />)
    expect(screen.container.textContent).toBe('')
    await screen.unmount()
  }
})
