import { lazy, StrictMode, useEffect, useState } from 'react'
import { expect, test } from 'vitest'
import { renderWithRouter } from '~test/browser/render'
import { LazyDialogMount } from './LazyDialogMount'

// A fresh lazy() per test, so no test sees another's loaded module. `loads`
// counts factory calls, `mounts` counts mount effects of the loaded component.
function makeLazyDialog() {
  const stats = { loads: 0, mounts: 0 }
  const Dialog = lazy(async () => {
    stats.loads += 1
    return {
      default: ({ open }: { open: boolean }) => {
        useEffect(() => {
          stats.mounts += 1
        }, [])
        return <p>{open ? 'shown' : 'closing'}</p>
      },
    }
  })
  return { stats, Dialog }
}

function Harness({
  initial,
  Dialog,
}: {
  initial: boolean
  Dialog: ReturnType<typeof makeLazyDialog>['Dialog']
}) {
  const [open, setOpen] = useState(initial)
  return (
    <>
      <button type="button" onClick={() => setOpen((o) => !o)}>
        toggle
      </button>
      <LazyDialogMount open={open}>
        <Dialog open={open} />
      </LazyDialogMount>
    </>
  )
}

test('never opened: renders nothing and never loads the dialog', async () => {
  const { stats, Dialog } = makeLazyDialog()
  const { screen } = await renderWithRouter(<Harness initial={false} Dialog={Dialog} />)
  await expect.element(screen.getByRole('button', { name: 'toggle' })).toBeVisible()
  expect(screen.getByText(/shown|closing/).elements()).toHaveLength(0)
  expect(stats.loads).toBe(0)
})

test('open: loads and renders the dialog; closed again: it stays mounted', async () => {
  const { stats, Dialog } = makeLazyDialog()
  const { screen } = await renderWithRouter(<Harness initial={false} Dialog={Dialog} />)
  await screen.getByRole('button', { name: 'toggle' }).click()
  await expect.element(screen.getByText('shown')).toBeVisible()
  await screen.getByRole('button', { name: 'toggle' }).click()
  // Still mounted with open=false: Radix plays its exit animation.
  await expect.element(screen.getByText('closing')).toBeVisible()
  await screen.getByRole('button', { name: 'toggle' }).click()
  await expect.element(screen.getByText('shown')).toBeVisible()
  expect(stats.loads).toBe(1)
  // Never unmounted and remounted across close and reopen.
  expect(stats.mounts).toBe(1)
})

test('StrictMode: stays mounted across close and reopen', async () => {
  const { stats, Dialog } = makeLazyDialog()
  const { screen } = await renderWithRouter(
    <StrictMode>
      <Harness initial={false} Dialog={Dialog} />
    </StrictMode>,
  )
  await screen.getByRole('button', { name: 'toggle' }).click()
  await expect.element(screen.getByText('shown')).toBeVisible()
  const mountsAfterOpen = stats.mounts
  await screen.getByRole('button', { name: 'toggle' }).click()
  await expect.element(screen.getByText('closing')).toBeVisible()
  await screen.getByRole('button', { name: 'toggle' }).click()
  await expect.element(screen.getByText('shown')).toBeVisible()
  expect(stats.mounts).toBe(mountsAfterOpen)
})

test('open on first render (a URL deep link): the dialog loads cold and renders after hydration', async () => {
  const { stats, Dialog } = makeLazyDialog()
  const { screen } = await renderWithRouter(<Harness initial Dialog={Dialog} />)
  await expect.element(screen.getByText('shown')).toBeVisible()
  expect(stats.loads).toBe(1)
})
