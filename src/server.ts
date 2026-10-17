// TanStack Start custom server entry. Wraps every incoming request (SSR,
// /api/rpc, /api/auth/*, server fns):
// - in a Server-Timing collector (~/lib/serverTiming), so every response says
//   where its time went;
// - in Paraglide's AsyncLocalStorage scope so getLocale() resolves the
//   request's videbacken-locale cookie anywhere on the server. Outside a
//   request scope (queue consumer, scripts) getLocale() falls back to the base
//   locale.
// On an instance's first request it also starts opening the DB pool's warm
// connections, before the request's route modules load (server-latency row 8).
// Inside the request, not at module init: Vercel may suspend an instance with
// work started outside one in flight; `waitUntil` keeps it up until the
// connections settle, and the request doesn't wait for them.
import handler from '@tanstack/react-start/server-entry'
import { waitUntil } from '@vercel/functions'
import { warmUpPool } from '~/lib/services/dbPool'
import { withServerTiming } from '~/lib/serverTiming'
import { paraglideMiddleware } from '~/paraglide/server'

export default {
  fetch(req: Request): Promise<Response> {
    const warming = warmUpPool()
    if (warming) waitUntil(warming)
    return withServerTiming(req, () => paraglideMiddleware(req, () => handler.fetch(req)))
  },
}
