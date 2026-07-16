import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { BookingSection } from '~/components/booking/BookingSection'
import { PageContainer } from '~/components/layout/PageContainer'
import { PasskeySetupPrompt } from '~/components/passkey/PasskeySetupPrompt'
import { DisponeringslistaTable } from '~/components/season/DisponeringslistaTable'
import { usePasskeySetupPrompt } from '~/hooks/usePasskeys'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'

export const Route = createFileRoute('/_authenticated/')({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(orpc.season.listSchedules.queryOptions())
    await queryClient.ensureQueryData(orpc.share.listMine.queryOptions())
    await queryClient.ensureQueryData(orpc.booking.getActive.queryOptions())
  },
  component: Calendar,
})

function Calendar() {
  const { user } = Route.useRouteContext()
  const { data: seasons } = useSuspenseQuery(orpc.season.listSchedules.queryOptions())
  const { data: ownedShares } = useSuspenseQuery(orpc.share.listMine.queryOptions())
  const { data: booking } = useSuspenseQuery(orpc.booking.getActive.queryOptions())

  const ownedShareCodes = new Set(ownedShares)

  // Periodic passkey nudge: self-gates on zero passkeys + the per-device snooze window
  // (see usePasskeySetupPrompt), so it re-appears "sometimes" for anyone without a passkey
  // — including invitees who skipped the onboarding step — rather than only after sign-in.
  const passkeyPrompt = usePasskeySetupPrompt()

  return (
    <PageContainer width="full" fill="lg">
      <h1 className="font-bold text-2xl tracking-tight text-balance md:text-3xl">
        {m.nav_calendar()}
      </h1>
      <BookingSection
        data={booking}
        isAdmin={user.role === 'admin'}
        ownedShareCodes={ownedShareCodes}
      />
      <DisponeringslistaTable
        schedules={seasons.schedules}
        currentYear={seasons.currentYear}
        ownedShareCodes={ownedShareCodes}
      />
      <PasskeySetupPrompt
        open={passkeyPrompt.open}
        pending={passkeyPrompt.pending}
        onCreate={passkeyPrompt.create}
        onDismiss={passkeyPrompt.dismiss}
      />
    </PageContainer>
  )
}
