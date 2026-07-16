import { m } from '~/paraglide/messages'

type Props = { email: string }

export function MagicLinkSentCard({ email }: Props) {
  return (
    <div className="flex w-full flex-col gap-2 text-center">
      <h1 className="font-heading font-semibold text-2xl tracking-tight">
        {m.login_sent_description()}
      </h1>
      <p className="text-muted-foreground text-sm">
        {m.login_sent_to()} <strong className="text-foreground">{email}</strong>.{' '}
        {m.login_sent_instructions()}
      </p>
    </div>
  )
}
