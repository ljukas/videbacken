import { createFileRoute } from '@tanstack/react-router'
import { handleZaptecSyncCron } from '~/lib/evCharging/zaptecSyncCron'

// Hourly Vercel Cron target (scheduled in vite.config.ts `vercel.config.crons`).
// Auth is `Authorization: Bearer $CRON_SECRET`, checked by the handler. Outside
// the `_authenticated` guard, like api/webhooks/shelly.ts. All logic lives in
// the testable handler; this file is just the route binding.
export const Route = createFileRoute('/api/cron/zaptec-sync')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => handleZaptecSyncCron(request),
    },
  },
})
