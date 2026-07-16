import { Button } from '~/components/ui/button'
import { m } from '~/paraglide/messages'

type Props = { onContinue: () => void }

export function SignedInCard({ onContinue }: Props) {
  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-col gap-1.5 text-center">
        <h1 className="font-heading font-semibold text-2xl tracking-tight">
          {m.login_signed_in_description()}
        </h1>
        <p className="text-balance text-muted-foreground text-sm">{m.login_signed_in_body()}</p>
      </header>

      <Button size="xl" className="w-full font-normal" onClick={onContinue}>
        {m.login_continue_here()}
      </Button>
    </div>
  )
}
