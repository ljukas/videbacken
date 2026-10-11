import { createFileRoute } from '@tanstack/react-router'
import { handleComfortCloudSyncCron } from '~/lib/heatPump/comfortCloudSyncCron'

// Every 6 h at :20 Vercel Cron target (vite.config.ts `vercel.config.crons`).
// Auth is `Authorization: Bearer $CRON_SECRET`, checked by the handler. Outside
// the `_authenticated` guard, like api/cron/emaldo-sync.ts.
export const Route = createFileRoute('/api/cron/comfort-cloud-sync')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => handleComfortCloudSyncCron(request),
    },
  },
})
