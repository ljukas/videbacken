import { ORPCError } from '@orpc/client'
import { useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import type { HomePositionMapProps } from './HomePositionMap'
import { HomePositionPicker } from './HomePositionPicker'

const { homePositionFn, searchFn, webgl, mapState } = vi.hoisted(() => ({
  homePositionFn: vi.fn(),
  searchFn: vi.fn(),
  webgl: { ok: true },
  mapState: { throws: false, last: null as null | Record<string, unknown> },
}))
vi.mock('~/lib/orpc/client', () => ({
  orpc: {
    credentials: {
      homePosition: {
        queryOptions: (o: Record<string, unknown> = {}) => ({
          ...o,
          queryKey: ['credentials', 'homePosition'],
          queryFn: homePositionFn,
        }),
      },
      searchAddress: {
        queryOptions: (o: { input: { query: string } } & Record<string, unknown>) => ({
          ...o,
          queryKey: ['credentials', 'searchAddress', o.input],
          queryFn: () => searchFn(o.input),
        }),
      },
    },
  },
}))
vi.mock('./mapSupport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mapSupport')>()),
  supportsWebGL2: () => webgl.ok,
}))
// The real map needs WebGL and tiles: a stand-in that shows its props and can pick.
vi.mock('./HomePositionMap', () => ({
  HomePositionMap: (props: HomePositionMapProps) => {
    if (mapState.throws) throw new Error('GPU init failed')
    mapState.last = props as unknown as Record<string, unknown>
    return (
      <div data-testid="map" data-point={JSON.stringify(props.point)}>
        <button
          type="button"
          onClick={() => props.onPick({ latitude: 57.123456789, longitude: 11.987654321 })}
        >
          fake map click
        </button>
      </div>
    )
  },
}))

const submitted = vi.fn()
function Harness({ initial = '', disabled = false }: { initial?: string; disabled?: boolean }) {
  const [value, setValue] = useState(initial)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submitted()
      }}
    >
      <HomePositionPicker
        value={value}
        onChange={setValue}
        disabled={disabled}
        header={<span>hints</span>}
        headerId="home-header"
        idBase="home"
      >
        <input aria-label="coords" value={value} onChange={(e) => setValue(e.target.value)} />
      </HomePositionPicker>
    </form>
  )
}
const deferred = <T,>() => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  homePositionFn.mockReset().mockResolvedValue(null)
  searchFn.mockReset().mockResolvedValue([])
  submitted.mockReset()
  webgl.ok = true
  mapState.throws = false
  mapState.last = null
})
afterEach(() => vi.restoreAllMocks())

test('opens on the saved pin', async () => {
  homePositionFn.mockResolvedValue({ latitude: 59.3293, longitude: 18.0686 })
  const { screen } = await renderWithProviders(<Harness />)
  await expect.element(screen.getByLabelText('coords')).toHaveValue('59.32930,18.06860')
  await expect
    .element(screen.getByTestId('map'))
    .toHaveAttribute('data-point', JSON.stringify({ latitude: 59.3293, longitude: 18.0686 }))
  expect(mapState.last?.camera).toEqual({
    center: { latitude: 59.3293, longitude: 18.0686 },
    zoom: 16,
  })
})

test('a pick before the saved pin arrives is kept', async () => {
  const saved = deferred<{ latitude: number; longitude: number }>()
  homePositionFn.mockReturnValue(saved.promise)
  const { screen } = await renderWithProviders(<Harness />)
  await screen.getByRole('button', { name: 'fake map click' }).click()
  saved.resolve({ latitude: 59.3293, longitude: 18.0686 })
  await vi.waitFor(() => expect(homePositionFn).toHaveBeenCalled())
  await new Promise((r) => setTimeout(r, 50))
  await expect.element(screen.getByLabelText('coords')).toHaveValue('57.12346,11.98765')
})

test('without a saved pin, or with an unreadable one, the map opens on Sweden and nothing is set', async () => {
  homePositionFn.mockRejectedValue(new ORPCError('UNREADABLE', { defined: true }))
  const { screen } = await renderWithProviders(<Harness />)
  await expect.element(screen.getByTestId('map')).toBeVisible()
  expect(mapState.last?.initialView).toEqual({
    center: { latitude: 62.0, longitude: 15.0 },
    zoom: 3.6,
  })
  await expect.element(screen.getByLabelText('coords')).toHaveValue('')
})

test('a map pick is rounded to five decimals and announced', async () => {
  const { screen } = await renderWithProviders(<Harness />)
  await screen.getByRole('button', { name: 'fake map click' }).click()
  await expect.element(screen.getByLabelText('coords')).toHaveValue('57.12346,11.98765')
  await expect
    .element(screen.getByText(m.charging_home_chosen({ lat: '57.12346', lon: '11.98765' })))
    .toBeInTheDocument()
})

test('typed coordinates move the pin', async () => {
  const { screen } = await renderWithProviders(<Harness />)
  await screen.getByLabelText('coords').fill('58.5,13.25')
  await expect
    .element(screen.getByTestId('map'))
    .toHaveAttribute('data-point', JSON.stringify({ latitude: 58.5, longitude: 13.25 }))
})

test('Enter searches and never submits the form; picking a hit moves the pin', async () => {
  searchFn.mockResolvedValue([
    { label: 'Storgatan 1, Exempelby', latitude: 57.7, longitude: 11.97 },
    { label: 'Storgatan 1, Annanstad', latitude: 59.1, longitude: 17.2 },
  ])
  const { screen } = await renderWithProviders(<Harness />)
  const search = screen.getByLabelText(m.charging_home_search_label())
  await search.fill('Storgatan 1')
  await userEventEnter(search.element() as HTMLInputElement)
  await vi.waitFor(() => expect(searchFn).toHaveBeenCalledWith({ query: 'Storgatan 1' }))
  expect(submitted).not.toHaveBeenCalled()
  await screen.getByRole('button', { name: 'Storgatan 1, Exempelby' }).click()
  await expect.element(screen.getByLabelText('coords')).toHaveValue('57.70000,11.97000')
  expect(mapState.last?.camera).toEqual({ center: { latitude: 57.7, longitude: 11.97 }, zoom: 17 })
  await expect
    .element(screen.getByRole('button', { name: 'Storgatan 1, Annanstad' }))
    .not.toBeInTheDocument()
  await expect.element(search).toHaveFocus()
})

test('Sök with fewer than two characters does nothing', async () => {
  const { screen } = await renderWithProviders(<Harness />)
  await screen.getByLabelText(m.charging_home_search_label()).fill(' a ')
  await screen.getByRole('button', { name: m.charging_home_search(), exact: true }).click()
  await new Promise((r) => setTimeout(r, 50))
  expect(searchFn).not.toHaveBeenCalled()
})

test('no hits and a failed search each say so; the map stays', async () => {
  const { screen } = await renderWithProviders(<Harness />)
  const search = screen.getByLabelText(m.charging_home_search_label())
  await search.fill('Ingenstans')
  await screen.getByRole('button', { name: m.charging_home_search(), exact: true }).click()
  await expect.element(screen.getByText(m.charging_home_search_empty())).toBeVisible()

  searchFn.mockRejectedValue(new ORPCError('GEOCODER_UNAVAILABLE', { defined: true }))
  await search.fill('Någonstans')
  await screen.getByRole('button', { name: m.charging_home_search(), exact: true }).click()
  await expect.element(screen.getByText(m.charging_home_search_unavailable())).toBeVisible()
  await expect.element(screen.getByTestId('map')).toBeVisible()
})

test('Använd min position moves the pin there; a refusal says so', async () => {
  const geo = vi.spyOn(navigator.geolocation, 'getCurrentPosition')
  geo.mockImplementation((ok) =>
    ok({ coords: { latitude: 58.4, longitude: 15.6 } } as GeolocationPosition),
  )
  const { screen } = await renderWithProviders(<Harness />)
  const locate = screen.getByRole('button', { name: m.charging_home_use_location() })
  await locate.click()
  await expect.element(screen.getByLabelText('coords')).toHaveValue('58.40000,15.60000')
  expect(mapState.last?.camera).toEqual({ center: { latitude: 58.4, longitude: 15.6 }, zoom: 17 })

  geo.mockImplementation((_ok, fail) =>
    fail?.({
      code: 1,
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3,
    } as GeolocationPositionError),
  )
  await locate.click()
  await expect.element(screen.getByText(m.charging_home_location_denied())).toBeVisible()
  geo.mockImplementation((_ok, fail) =>
    fail?.({
      code: 3,
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3,
    } as GeolocationPositionError),
  )
  await locate.click()
  await expect.element(screen.getByText(m.charging_home_location_unavailable())).toBeVisible()
})

test('without WebGL2 a note replaces the map; search and coordinates remain', async () => {
  webgl.ok = false
  const { screen } = await renderWithProviders(<Harness />)
  await expect.element(screen.getByText(m.charging_home_no_map())).toBeVisible()
  expect(screen.getByTestId('map').elements()).toHaveLength(0)
  await expect.element(screen.getByLabelText(m.charging_home_search_label())).toBeVisible()
  await expect.element(screen.getByLabelText('coords')).toBeVisible()
})

test('a map that fails to start shows the same note', async () => {
  mapState.throws = true
  const { screen } = await renderWithProviders(<Harness />)
  await expect.element(screen.getByText(m.charging_home_no_map())).toBeVisible()
  await expect.element(screen.getByLabelText('coords')).toBeVisible()
})

test('disabled shows only the coordinates and fetches nothing', async () => {
  const { screen } = await renderWithProviders(<Harness disabled />)
  await expect.element(screen.getByLabelText('coords')).toBeVisible()
  expect(screen.getByLabelText(m.charging_home_search_label()).elements()).toHaveLength(0)
  expect(screen.getByTestId('map').elements()).toHaveLength(0)
  await new Promise((r) => setTimeout(r, 50))
  expect(homePositionFn).not.toHaveBeenCalled()
})

async function userEventEnter(input: HTMLInputElement) {
  const { userEvent } = await import('vitest/browser')
  input.focus()
  await userEvent.keyboard('{Enter}')
}
