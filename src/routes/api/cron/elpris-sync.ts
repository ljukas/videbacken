import { createFileRoute } from '@tanstack/react-router'
import { handleElprisSyncCron } from '~/lib/spotPrice/elprisSyncCron'

// Daily Vercel Cron target (scheduled in vite.config.ts `vercel.config.crons`):
// fetches missing SE3 spot price days after tomorrow's prices publish (~13:00).
// Auth is `Authorization: Bearer $CRON_SECRET`, checked by the handler. Outside
// the `_authenticated` guard, like api/cron/zaptec-sync.ts.
export const Route = createFileRoute('/api/cron/elpris-sync')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => handleElprisSyncCron(request),
    },
  },
})
