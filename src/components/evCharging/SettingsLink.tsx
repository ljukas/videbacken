import { Link } from '@tanstack/react-router'
import type * as React from 'react'
import { Button } from '~/components/ui/button'
import { m } from '~/paraglide/messages'

// "Go fix it there": the charging settings page (admins only) holds every data
// source, its sync and history, and the tariffs. Sized like SyncNowButton so the
// two sit side by side in an alert's action row.
export function SettingsLink({
  search,
  children,
}: {
  search?: { dialog: 'tariffNew' }
  children?: React.ReactNode
}) {
  return (
    <Button asChild size="sm" variant="outline">
      <Link to="/charging/settings" search={search}>
        {children ?? m.charging_settings_link()}
      </Link>
    </Button>
  )
}
