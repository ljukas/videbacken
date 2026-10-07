// TanStack Start custom server entry. Wraps every incoming request (SSR,
// /api/rpc, /api/auth/*, server fns):
// - in a Server-Timing collector (~/lib/serverTiming), so every response says
//   where its time went;
// - in Paraglide's AsyncLocalStorage scope so getLocale() resolves the
//   request's videbacken-locale cookie anywhere on the server. Outside a
//   request scope (queue consumer, scripts) getLocale() falls back to the base
//   locale.
import handler from '@tanstack/react-start/server-entry'
import { withServerTiming } from '~/lib/serverTiming'
import { paraglideMiddleware } from '~/paraglide/server'

export default {
  fetch(req: Request): Promise<Response> {
    return withServerTiming(req, () => paraglideMiddleware(req, () => handler.fetch(req)))
  },
}
