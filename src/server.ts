// TanStack Start custom server entry. Currently wraps every incoming request
// (SSR, /api/rpc, /api/auth/*, server fns) in Paraglide's AsyncLocalStorage
// scope so getLocale() resolves the request's oceanview-locale cookie anywhere
// on the server. Outside a request scope (queue consumer, scripts) getLocale()
// falls back to the base locale.
import handler from '@tanstack/react-start/server-entry'
import { paraglideMiddleware } from '~/paraglide/server'

export default {
  fetch(req: Request): Promise<Response> {
    return paraglideMiddleware(req, () => handler.fetch(req))
  },
}
