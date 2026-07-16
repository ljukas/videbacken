import { createFileRoute } from '@tanstack/react-router'
import { Suspense } from 'react'
import { ProfileCard } from '~/components/user/ProfileCard'
import { m } from '~/paraglide/messages'

// Account information subpage: avatar + email (read-only) + name + phone, as one
// Linear-style card (ProfileCard). `user.me` is warmed by the parent account
// layout loader; the Suspense boundary covers the suspending ProfileCard.
export const Route = createFileRoute('/_authenticated/account/profile')({
  component: AccountProfile,
})

function AccountProfile() {
  return (
    <Suspense fallback={<div className="text-muted-foreground text-sm">{m.common_loading()}</div>}>
      <ProfileCard />
    </Suspense>
  )
}
