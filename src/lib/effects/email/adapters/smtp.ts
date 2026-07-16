import nodemailer, { type Transporter } from 'nodemailer'
import { renderInviteUser } from '~/emails/InviteUserEmail'
import { renderMagicLink } from '~/emails/MagicLinkEmail'
import { logger } from '~/lib/logger/server'
import type { EmailEffects } from '../email'

let transporter: Transporter | null = null
function getTransport(): Transporter {
  if (transporter) return transporter
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 14522),
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
}
