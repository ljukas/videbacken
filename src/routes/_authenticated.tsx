import { environmentManager, focusManager, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { useEffect } from 'react'
import { AppSidebar } from '~/components/AppSidebar'
import { CommandPalette } from '~/components/command/CommandPalette'
import { CommandTriggerButton } from '~/components/command/CommandTriggerButton'
import { CommandPaletteProvider } from '~/components/command/useCommandPalette'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '~/components/ui/sidebar'
import { TooltipProvider } from '~/components/ui/tooltip'
import { HeaderUserMenu } from '~/components/user/UserMenu'
import { rememberBrowserUser } from '~/lib/browserSessionFns'
import { orpc } from '~/lib/orpc/client'
import { sessionQueryOptions } from '~/lib/sessionQuery'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ location, context: { queryClient } }) => {
    // fetchQuery: cached for the cookie-cache lifetime, re-checked after it
    // (ensureQueryData would keep returning a stale session forever).
    const session = await queryClient.fetchQuery(sessionQueryOptions)
    if (!session || session.user.deletedAt) {
      queryClient.removeQueries({ queryKey: sessionQueryOptions.queryKey })
      throw redirect({ to: '/login', search: { redirect: location.href } })
    }
    if (environmentManager.isServer()) {
      await rememberBrowserUser({
        data: { email: session.user.email, userId: session.user.id },
      })
    }
    return { user: session.user }
  },
  loader: async ({ context: { queryClient } }) => {
    // Gate on the *fresh* me (orpc.user.me bypasses the session cookie cache),
    // so a just-completed onboarding isn't masked by the ≤5-min cached session —
    // otherwise the user would bounce back here in a loop. An invitee who hasn't
    // finished the wizard (onboardedAt === null) is sent to the full-screen
    // /onboarding route (outside this layout). See ADR-0017.
    const me = await queryClient.ensureQueryData(orpc.user.me.queryOptions())
    if (me.onboardedAt == null) throw redirect({ to: '/onboarding', search: { step: 'name' } })
    return me
  },
  component: AuthenticatedLayout,
})

function AuthenticatedLayout() {
  const { user } = Route.useRouteContext()
  const queryClient = useQueryClient()

  // Returning to the tab re-checks the session on the next navigation, so a
  // sign-out in another tab is noticed then (ADR-0025 §2).
  useEffect(
    () =>
      focusManager.subscribe((focused) => {
        if (focused) void queryClient.invalidateQueries({ queryKey: sessionQueryOptions.queryKey })
      }),
    [queryClient],
  )

  return (
    <CommandPaletteProvider>
      <TooltipProvider>
        {/* Fixed-height panel with an inner scroller from md up; on a phone the
            document scrolls, so iOS Safari can shrink its toolbars (PageContainer). */}
        <SidebarProvider className="md:h-svh md:overflow-hidden">
          <AppSidebar role={user.role} />
          <SidebarInset className="min-w-0 bg-surface-page md:min-h-0 md:overflow-hidden">
            <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b bg-surface-page px-4 md:hidden">
              <SidebarTrigger />
              <div className="flex flex-1 justify-center px-3">
                <CommandTriggerButton className="max-w-xs" />
              </div>
              <HeaderUserMenu />
            </header>
            <Outlet />
          </SidebarInset>
          <CommandPalette role={user.role} />
        </SidebarProvider>
      </TooltipProvider>
    </CommandPaletteProvider>
  )
}
