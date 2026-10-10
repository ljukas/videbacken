import { afterEach, expect, test, vi } from 'vitest'
import { Route as Economy } from './economy'
import { Route as Overview } from './index'
import { Route as Patterns } from './patterns'

// The routes' own search schema and loaders, not copies. The `-` prefix keeps
// this file out of the route tree.
type Validate = (s: unknown) => { vehicle?: string }
type RouteLike = {
  options: { validateSearch?: unknown; loaderDeps?: unknown; loader?: unknown }
}
const routes: [string, RouteLike][] = [
  ['overview', Overview as unknown as RouteLike],
  ['patterns', Patterns as unknown as RouteLike],
  ['economy', Economy as unknown as RouteLike],
]

function validator(route: RouteLike): Validate {
  const v = route.options.validateSearch as Validate | { parse: Validate }
  return typeof v === 'function' ? v : (s) => v.parse(s)
}

afterEach(() => {
  vi.restoreAllMocks()
})

test.each(routes)('%s: a junk ?vehicle= falls back to the default', (_name, route) => {
  const validate = validator(route)
  expect(validate({ vehicle: 'neighbour' }).vehicle).toBeUndefined()
  expect(validate({ vehicle: 'other' }).vehicle).toBe('other')
  expect(validate({ vehicle: 'ours' }).vehicle).toBe('ours')
  expect(validate({}).vehicle).toBeUndefined()
})

type Spy = ReturnType<typeof vi.fn>
async function runLoader(route: RouteLike, search: Record<string, unknown>) {
  const validate = validator(route)
  const deps = (route.options.loaderDeps as (a: { search: unknown }) => unknown)({
    search: validate(search),
  })
  const calls: { queryKey: unknown }[] = []
  const record = (opts: { queryKey: unknown }) => {
    calls.push(opts)
    return Promise.resolve({ sessions: [], years: [], months: [] })
  }
  const queryClient = {
    ensureQueryData: vi.fn(record),
    prefetchQuery: vi.fn(record),
    getQueryData: vi.fn(() => undefined),
  } as { ensureQueryData: Spy; prefetchQuery: Spy; getQueryData: Spy }
  const loader = route.options.loader as (a: unknown) => Promise<unknown>
  await loader({
    context: { queryClient, user: { role: 'user' } },
    deps,
    // As the router passes it: the raw search (the /charging loader reads its page from it).
    location: { search },
  })
  return calls.map((c) => JSON.stringify(c.queryKey))
}

// oRPC query keys embed the procedure path and the input.
const scoped = (keys: string[], procedure: string) =>
  keys.filter((k) => k.includes(`"${procedure}"`))

test.each([
  ['overview', Overview, ['overview', 'sessions', 'costOverview']],
  ['patterns', Patterns, ['patterns', 'timeline']],
  ['economy', Economy, ['economy', 'economySessions']],
] as const)('%s: a clean URL requests everything, ?vehicle=ours passes ours', async (_n, route, procs) => {
  const clean = await runLoader(route as unknown as RouteLike, {})
  const ours = await runLoader(route as unknown as RouteLike, { vehicle: 'ours' })
  for (const p of procs) {
    const c = scoped(clean, p)
    const o = scoped(ours, p)
    expect(c.length, `${p} requested`).toBeGreaterThan(0)
    expect(o.length, `${p} requested for ours`).toBeGreaterThan(0)
    for (const k of c) expect(k).toContain('"vehicle":"all"')
    for (const k of o) expect(k).toContain('"vehicle":"ours"')
  }
})

test.each([
  ['overview', Overview],
  ['economy', Economy],
] as const)('%s: the session list’s page and size are no loader deps', (_n, route) => {
  // A dep change blocks a navigation on the whole loader; a page click must not.
  const r = route as unknown as RouteLike
  const deps = (search: Record<string, unknown>) =>
    (r.options.loaderDeps as (a: { search: unknown }) => unknown)({ search: validator(r)(search) })
  expect(deps({ page: 2, size: 25 })).toEqual(deps({}))
})

test('economy: the session list’s page and size come from the URL, not the deps', async () => {
  const keys = await runLoader(Economy as unknown as RouteLike, { page: 3, size: 25 })
  const list = scoped(keys, 'economySessions')
  expect(list).toHaveLength(1)
  expect(list[0]).toContain('"page":3')
  expect(list[0]).toContain('"pageSize":25')
})
