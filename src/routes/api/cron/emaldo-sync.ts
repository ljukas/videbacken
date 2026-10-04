import { createFileRoute } from '@tanstack/react-router'
import { handleEmaldoSyncCron } from '~/lib/houseEnergy/emaldoSyncCron'

// Hourly (:45) Vercel Cron target (vite.config.ts `vercel.config.crons`). Auth
// is `Authorization: Bearer $CRON_SECRET`, checked by the handler. Outside the
// `_authenticated` guard, like api/cron/zaptec-sync.ts.
export const Route = createFileRoute('/api/cron/emaldo-sync')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => handleEmaldoSyncCron(request),
    },
  },
})
