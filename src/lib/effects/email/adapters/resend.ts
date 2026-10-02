import { Resend } from 'resend'
import { renderCredentialExpiry } from '~/emails/CredentialExpiryEmail'
import { renderGridTariffAvailable } from '~/emails/GridTariffAvailableEmail'
import { renderIntegrationSyncAlert } from '~/emails/IntegrationSyncAlertEmail'
import { renderInviteUser } from '~/emails/InviteUserEmail'
import { renderMagicLink } from '~/emails/MagicLinkEmail'
import { logger } from '~/lib/logger/server'
import type { EmailEffects } from '../email'

let client: Resend | null = null
function getClient(): Resend {
  if (!client) client = new Resend(process.env.RESEND_API_KEY)
  return client
}

export const resend: EmailEffects = {
  async sendMagicLink({ to, url, locale }) {
    const { subject, html, text } = await renderMagicLink({ url, locale })
    const from = process.env.EMAIL_FROM
    if (!from) throw new Error('EMAIL_FROM is required when RESEND_API_KEY is set')
    const result = await getClient().emails.send({ from, to, subject, html, text })
    if (result.error) throw new Error(`Resend send failed: ${result.error.message}`)
    logger.info('magic-link sent (resend)', { to, messageId: result.data?.id })
  },
  async sendUserInvited({ to, inviteUrl, locale }) {
    const { subject, html, text } = await renderInviteUser({ inviteUrl, locale })
    const from = process.env.EMAIL_FROM
    if (!from) throw new Error('EMAIL_FROM is required when RESEND_API_KEY is set')
    const result = await getClient().emails.send({ from, to, subject, html, text })
    if (result.error) throw new Error(`Resend send failed: ${result.error.message}`)
    logger.info('invite sent (resend)', { to, messageId: result.data?.id })
  },
  async sendIntegrationSyncAlert({ to, source, transition, code, locale }) {
    const { subject, html, text } = await renderIntegrationSyncAlert({
      source,
      transition,
      code,
      locale,
    })
    const from = process.env.EMAIL_FROM
    if (!from) throw new Error('EMAIL_FROM is required when RESEND_API_KEY is set')
    const result = await getClient().emails.send({ from, to, subject, html, text })
    if (result.error) throw new Error(`Resend send failed: ${result.error.message}`)
    logger.info('integration sync alert sent (resend)', {
      to,
      source,
      transition,
      messageId: result.data?.id,
    })
  },
  async sendGridTariffAvailable({ to, companyName, locale }) {
    const { subject, html, text } = await renderGridTariffAvailable({ companyName, locale })
    const from = process.env.EMAIL_FROM
    if (!from) throw new Error('EMAIL_FROM is required when RESEND_API_KEY is set')
    const result = await getClient().emails.send({ from, to, subject, html, text })
    if (result.error) throw new Error(`Resend send failed: ${result.error.message}`)
    logger.info('grid tariff available sent (resend)', { to, messageId: result.data?.id })
  },
  async sendCredentialExpiry({ to, source, expiresAt, days, locale }) {
    const { subject, html, text } = await renderCredentialExpiry({
      source,
      expiresAt,
      days,
      locale,
    })
    const from = process.env.EMAIL_FROM
    if (!from) throw new Error('EMAIL_FROM is required when RESEND_API_KEY is set')
    const result = await getClient().emails.send({ from, to, subject, html, text })
    if (result.error) throw new Error(`Resend send failed: ${result.error.message}`)
    logger.info('credential expiry sent (resend)', { to, source, days, messageId: result.data?.id })
  },
}
