import { createFileRoute } from '@tanstack/react-router'
import { handleCatalogueCheckCron } from '~/lib/gridTariff/catalogueCheckCron'

// Monthly Vercel Cron target (scheduled in vite.config.ts `vercel.config.crons`):
// emails admins once the Eltariff-API catalogue covers our facility. Auth is
// `Authorization: Bearer $CRON_SECRET`, checked by the handler. Outside the
// `_authenticated` guard, like api/cron/elpris-sync.ts.
export const Route = createFileRoute('/api/cron/grid-tariff-catalogue')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => handleCatalogueCheckCron(request),
    },
  },
})
