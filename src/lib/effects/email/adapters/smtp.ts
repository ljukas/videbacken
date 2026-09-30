import nodemailer, { type Transporter } from 'nodemailer'
import { renderGridTariffAvailable } from '~/emails/GridTariffAvailableEmail'
import { renderIntegrationSyncAlert } from '~/emails/IntegrationSyncAlertEmail'
import { renderInviteUser } from '~/emails/InviteUserEmail'
import { renderMagicLink } from '~/emails/MagicLinkEmail'
import { logger } from '~/lib/logger/server'
import type { EmailEffects } from '../email'

let transporter: Transporter | null = null
function getTransport(): Transporter {
  if (transporter) return transporter
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 14622),
    secure: false,
  })
  return transporter
}

export const smtp: EmailEffects = {
  async sendMagicLink({ to, url, locale }) {
    const { subject, html, text } = await renderMagicLink({ url, locale })
    await getTransport().sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject,
      html,
      text,
    })
    logger.info('magic-link sent (smtp)', { to })
  },
  async sendUserInvited({ to, inviteUrl, locale }) {
    const { subject, html, text } = await renderInviteUser({ inviteUrl, locale })
    await getTransport().sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject,
      html,
      text,
    })
    logger.info('invite sent (smtp)', { to })
  },
  async sendIntegrationSyncAlert({ to, source, transition, code, locale }) {
    const { subject, html, text } = await renderIntegrationSyncAlert({
      source,
      transition,
      code,
      locale,
    })
    await getTransport().sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject,
      html,
      text,
    })
    logger.info('integration sync alert sent (smtp)', { to, source, transition })
  },
  async sendGridTariffAvailable({ to, companyName, locale }) {
    const { subject, html, text } = await renderGridTariffAvailable({ companyName, locale })
    await getTransport().sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject,
      html,
      text,
    })
    logger.info('grid tariff available sent (smtp)', { to })
  },
}
