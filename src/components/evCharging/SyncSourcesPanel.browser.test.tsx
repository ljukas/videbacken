import { useState } from 'react'
import { expect, test, vi } from 'vitest'
import type { IntegrationSource } from '~/lib/integrationHealth'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { type SourceEntry, SyncSourcesPanel } from './SyncSourcesPanel'
import type { SourceHealth as Health } from './syncHealth'

const health = (source: IntegrationSource, state: Health['state']): Health => ({
  source,
  state,
  running: false,
  progress: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  failingSince: null,
  consecutiveFailures: 0,
  code: null,
  adminDetail: null,
})
const runs = {
  data: [],
  isPlaceholderData: false,
  errorUpdateCount: 0,
  isFetching: false,
  refetch: () => {},
}

const entries: SourceEntry[] = [
  { source: 'zaptec', health: health('zaptec', 'ok'), runs },
  { source: 'elpris', health: health('elpris', 'ok'), runs },
  { source: 'skoda', health: health('skoda', 'stale'), runs },
  { source: 'emaldo', health: undefined, runs: undefined },
]

const named = (action: string, source: string) => ({
  name: m.charging_source_action_label({ action, source }),
})
const title = (source: string) => m.charging_source_dialog_title({ source })

function panel(props: Partial<Parameters<typeof SyncSourcesPanel>[0]> = {}) {
  return (
    <SyncSourcesPanel
      entries={entries}
      onSync={() => {}}
      isPendingFor={() => false}
      openSource={undefined}
      onOpenHistory={() => {}}
      onCloseHistory={() => {}}
      {...props}
    />
  )
}

test('a labelled list of one tile per source, with a summary', async () => {
  const { screen } = await renderWithProviders(panel())
  await expect
    .element(screen.getByRole('heading', { name: m.charging_sources_heading(), level: 2 }))
    .toBeVisible()
  await expect
    .element(screen.getByText(m.charging_sources_summary({ ok: 2, total: 4 })))
    .toBeVisible()
  // Emaldo's state wasn't read: unknown, not "not working".
  await expect
    .element(screen.getByText(m.charging_sources_summary_unknown({ count: 1 }), { exact: false }))
    .toBeVisible()
  expect(screen.getByRole('list').elements()).toHaveLength(1)
  expect(screen.getByRole('listitem').elements()).toHaveLength(4)
  for (const name of ['Zaptec', 'elprisetjustnu.se', 'Škoda', 'Emaldo']) {
    await expect.element(screen.getByRole('heading', { name, level: 3 })).toBeVisible()
  }
})

test('a tile routes sync and history to its own source', async () => {
  const onSync = vi.fn()
  const onOpenHistory = vi.fn()
  const { screen } = await renderWithProviders(panel({ onSync, onOpenHistory }))
  await screen.getByRole('button', named(m.charging_sync_now(), 'Škoda')).click()
  await screen.getByRole('button', named(m.charging_source_history(), 'elprisetjustnu.se')).click()
  expect(onSync).toHaveBeenCalledWith('skoda')
  expect(onOpenHistory).toHaveBeenCalledWith('elpris')
})

test('only the pending source shows as syncing', async () => {
  const { screen } = await renderWithProviders(
    panel({ isPendingFor: (source) => source === 'elpris' }),
  )
  await expect
    .element(screen.getByRole('button', named(m.charging_source_syncing(), 'elprisetjustnu.se')))
    .toHaveAttribute('aria-disabled', 'true')
  await expect
    .element(screen.getByRole('button', named(m.charging_sync_now(), 'Zaptec')))
    .not.toHaveAttribute('aria-disabled')
})

test('the open source shows its history overlay', async () => {
  const { screen } = await renderWithProviders(panel({ openSource: 'skoda' }))
  await expect.element(screen.getByRole('dialog', { name: title('Škoda') })).toBeVisible()
})

test('nothing open, no overlay', async () => {
  const { screen } = await renderWithProviders(panel())
  expect(screen.getByRole('dialog').elements()).toHaveLength(0)
})

// The route opens the overlay through URL state, not a Radix trigger, so the
// panel must put focus back on the button that opened it.
function Harness() {
  const [open, setOpen] = useState<IntegrationSource | undefined>()
  return panel({
    openSource: open,
    onOpenHistory: setOpen,
    onCloseHistory: () => setOpen(undefined),
  })
}

test('closing the overlay returns focus to the tile that opened it', async () => {
  const { screen } = await renderWithProviders(<Harness />)
  const history = screen.getByRole('button', named(m.charging_source_history(), 'Škoda'))
  await history.click()
  const overlay = screen.getByRole('dialog', { name: title('Škoda') })
  await expect.element(overlay).toBeVisible()
  await overlay.getByRole('button', { name: 'Close' }).click()
  await expect.poll(() => screen.getByRole('dialog').elements().length).toBe(0)
  await expect.element(history).toHaveFocus()
})
