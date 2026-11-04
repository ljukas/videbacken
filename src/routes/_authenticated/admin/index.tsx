import { createFileRoute, redirect } from '@tanstack/react-router'

// No admin overview yet: the section opens on its only page. The /admin
// layout's guard has already sent a member home.
export const Route = createFileRoute('/_authenticated/admin/')({
  beforeLoad: () => {
    throw redirect({ to: '/admin/settings', replace: true })
  },
})
