import { createFileRoute } from '@tanstack/react-router'
import { handleSilenceCron } from '~/lib/sensor/silenceCron'

// Hourly at :15 Vercel Cron target (vite.config.ts `vercel.config.crons`).
// Auth is `Authorization: Bearer $CRON_SECRET`, checked by the handler. Outside
// the `_authenticated` guard, like api/cron/comfort-cloud-sync.ts.
export const Route = createFileRoute('/api/cron/sensor-silence')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => handleSilenceCron(request),
    },
  },
})
