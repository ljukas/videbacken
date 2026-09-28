/**
 * Hand-written `fetch` stand-in for Zaptec client tests. Routes are keyed by
 * `"<METHOD> <pathname>"` (query string ignored); each handler receives the
 * real `Request` plus its 0-based call index for that route and returns a real
 * `Response` (or throws, to simulate a network failure).
 */
export type FakeRoute = (req: Request, call: number) => Response | Promise<Response>

export function fakeFetch(routes: Record<string, FakeRoute>) {
  const calls: Request[] = []
  const counts = new Map<string, number>()

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init)
    calls.push(req)
    const key = `${req.method} ${new URL(req.url).pathname}`
    const route = routes[key]
    if (!route) throw new Error(`fakeFetch: no route for ${key}`)
    const call = counts.get(key) ?? 0
    counts.set(key, call + 1)
    return route(req, call)
  }

  return {
    fetch: fetch as typeof globalThis.fetch,
    calls,
    /** Calls made to one route key, e.g. `'POST /oauth/token'`. */
    callsTo: (key: string) => calls.filter((r) => `${r.method} ${new URL(r.url).pathname}` === key),
  }
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}
