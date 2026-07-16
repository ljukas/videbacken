import { createFileRoute, redirect } from '@tanstack/react-router'

// /account has no page of its own — land on the first subpage. beforeLoad runs
// before render, so the layout shell never flashes. Kept as a safety net for
// bookmarks; the UserMenu links straight to /account/profile.
export const Route = createFileRoute('/_authenticated/account/')({
  beforeLoad: () => {
    throw redirect({ to: '/account/profile' })
  },
})
