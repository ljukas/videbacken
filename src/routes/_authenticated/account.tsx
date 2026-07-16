import { createFileRoute, Outlet } from '@tanstack/react-router'
import { AccountNav } from '~/components/account/AccountNav'
import { PageContainer } from '~/components/layout/PageContainer'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

// Layout route for the Account section. Holds the page header + inner nav
// (AccountNav) and renders the active subpage through <Outlet/>; the two
// subpages live under src/routes/_authenticated/account/. The loader warms
// `user.me` once for both subpages (ProfileCard + the security passkeys list).
export const Route = createFileRoute('/_authenticated/account')({
  head: () => ({
    meta: seo({
      title: m.meta_account_title(),
      description: m.meta_account_description(),
    }),
  }),
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(orpc.user.me.queryOptions())
  },
  component: AccountLayout,
})

function AccountLayout() {
  return (
    <PageContainer width="default">
      <header className="flex flex-col gap-2">
        <h1 className="font-bold text-3xl tracking-tight text-balance md:text-4xl">
          {m.account_title()}
        </h1>
        <p className="text-muted-foreground text-sm">{m.account_description()}</p>
      </header>

      <div className="flex flex-col gap-6 md:flex-row md:gap-10">
        <AccountNav className="md:w-48 md:shrink-0" />
        <div className="min-w-0 flex-1 md:max-w-2xl">
          <Outlet />
        </div>
      </div>
    </PageContainer>
  )
}
