import { createFileRoute } from '@tanstack/react-router'
import { LayoutDashboardIcon } from 'lucide-react'
import { PageContainer } from '~/components/layout/PageContainer'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { m } from '~/paraglide/messages'

// Minimal placeholder landing page (the sailboat-specific calendar/booking
// dashboard was removed with the domain strip — see Task 2 of the starter
// template plan). Later tasks give this route real content; for now it's a
// welcome heading + an on-brand empty state.
export const Route = createFileRoute('/_authenticated/')({
  component: Dashboard,
})

function Dashboard() {
  const { user } = Route.useRouteContext()

  return (
    <PageContainer>
      <h1 className="font-bold text-2xl tracking-tight text-balance md:text-3xl">
        {m.dashboard_welcome_heading({ name: user.name })}
      </h1>
      <Empty className="brand-wash rounded-lg border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LayoutDashboardIcon />
          </EmptyMedia>
          <EmptyTitle>{m.dashboard_empty_title()}</EmptyTitle>
          <EmptyDescription>{m.dashboard_empty_description()}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </PageContainer>
  )
}
