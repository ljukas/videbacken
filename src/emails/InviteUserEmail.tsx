import { render } from 'react-email'
import { m } from '~/paraglide/messages'
import type { Locale } from '~/paraglide/runtime'
import { BrandEmailLayout } from './BrandEmailLayout'

export interface InviteUserEmailProps {
  // Link to /login: the invitee is already on the approved_email allowlist by
  // the time this is sent, so Google sign-in or requesting a magic link there
  // just works — there's no token/accept step to carry (see ADR-0017
  // amendment).
  inviteUrl: string
  // Explicit rather than read from the Paraglide request scope: the invite email
  // is rendered by the queue worker, outside any request. See ADR-0008/0017.
  locale: Locale
}

export const InviteUserEmail = ({ inviteUrl, locale }: InviteUserEmailProps) => (
  <BrandEmailLayout
    locale={locale}
    actionUrl={inviteUrl}
    preview={m.email_invite_preview({}, { locale })}
    heading={m.email_invite_heading({}, { locale })}
    body={m.email_invite_body({}, { locale })}
    buttonLabel={m.email_invite_button({}, { locale })}
    fallbackText={m.email_invite_fallback({}, { locale })}
    footer={m.email_invite_ignore({}, { locale })}
  />
)

InviteUserEmail.PreviewProps = {
  // localhost origin so the preview server (:14601) loads email-logo.png from
  // the running dev app (:14600) when it's up.
  inviteUrl: 'http://localhost:14600/login',
  locale: 'sv',
} satisfies InviteUserEmailProps

export default InviteUserEmail

export async function renderInviteUser(props: InviteUserEmailProps) {
  const [html, text] = await Promise.all([
    render(<InviteUserEmail {...props} />),
    render(<InviteUserEmail {...props} />, { plainText: true }),
  ])
  return { subject: m.email_invite_subject({}, { locale: props.locale }), html, text }
}
