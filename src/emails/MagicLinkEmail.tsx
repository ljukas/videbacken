import { render } from 'react-email'
import { m } from '~/paraglide/messages'
import type { Locale } from '~/paraglide/runtime'
import { BrandEmailLayout } from './BrandEmailLayout'

export interface MagicLinkEmailProps {
  url: string
  // Explicit rather than read from the Paraglide request scope: emails may be
  // rendered outside a request (queue, previews, tests), and the caller knows
  // the recipient's locale.
  locale: Locale
}

export const MagicLinkEmail = ({ url, locale }: MagicLinkEmailProps) => (
  <BrandEmailLayout
    locale={locale}
    actionUrl={url}
    preview={m.email_magiclink_preview({}, { locale })}
    heading={m.email_magiclink_heading({}, { locale })}
    body={m.email_magiclink_body({}, { locale })}
    buttonLabel={m.email_magiclink_button({}, { locale })}
    fallbackText={m.email_magiclink_fallback({}, { locale })}
    footer={m.email_magiclink_ignore({}, { locale })}
  />
)

MagicLinkEmail.PreviewProps = {
  // localhost origin so the preview server (:14501) loads email-logo.png from
  // the running dev app (:14500) when it's up.
  url: 'http://localhost:14500/api/auth/magic-link/verify?token=preview',
  locale: 'sv',
} satisfies MagicLinkEmailProps

export default MagicLinkEmail

export async function renderMagicLink(props: MagicLinkEmailProps) {
  const [html, text] = await Promise.all([
    render(<MagicLinkEmail {...props} />),
    render(<MagicLinkEmail {...props} />, { plainText: true }),
  ])
  return { subject: m.email_magiclink_subject({}, { locale: props.locale }), html, text }
}
