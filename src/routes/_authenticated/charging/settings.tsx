import { createFileRoute, redirect } from '@tanstack/react-router'
import { settingsSearchSchema } from '../admin/-settingsSearch'

// The settings page moved to the admin section (/admin/settings). Emails sent
// before the move link here, some with a dialog in the query (?dialog=…), so
// this redirect keeps the search. A member is sent home by the /admin guard.
export const Route = createFileRoute('/_authenticated/charging/settings')({
  validateSearch: settingsSearchSchema,
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/admin/settings', search, replace: true })
  },
})
