import { createFileRoute } from '@tanstack/react-router'
import { handleSkodaSyncCron } from '~/lib/vehicleState/skodaSyncCron'

// 15-min Vercel Cron target (vite.config.ts `vercel.config.crons`). Auth is
// `Authorization: Bearer $CRON_SECRET`, checked by the handler. Outside the
// `_authenticated` guard, like api/cron/zaptec-sync.ts.
export const Route = createFileRoute('/api/cron/skoda-sync')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => handleSkodaSyncCron(request),
    },
  },
})
