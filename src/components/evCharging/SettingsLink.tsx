import { Link } from '@tanstack/react-router'
import type * as React from 'react'
import { Button } from '~/components/ui/button'
import type { CredentialSource } from '~/lib/integrationCredentials'
import { m } from '~/paraglide/messages'

// "Go fix it there": the admin settings page (/admin/settings) holds every data
// source, its sync and history, and the tariffs. Sized like SyncNowButton so the
// two sit side by side in an alert's action row.
export function SettingsLink({
  search,
  children,
  'aria-label': ariaLabel,
}: {
  search?: { dialog: 'tariffNew' } | { dialog: 'credentials'; source: CredentialSource }
  children?: React.ReactNode
  'aria-label'?: string
}) {
  return (
    <Button asChild size="sm" variant="outline">
      {/* AlertDescription underlines every link; this one is a button. */}
      <Link className="no-underline!" to="/admin/settings" search={search} aria-label={ariaLabel}>
        {children ?? m.charging_settings_link()}
      </Link>
    </Button>
  )
}
