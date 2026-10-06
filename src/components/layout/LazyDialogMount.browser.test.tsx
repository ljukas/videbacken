import { lazy, useState } from 'react'
import { expect, test } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { LazyDialogMount } from './LazyDialogMount'

let loads = 0
const Lazy = lazy(async () => {
  loads += 1
  return { default: ({ open }: { open: boolean }) => <p>{open ? 'shown' : 'closing'}</p> }
})

function Harness({ initial }: { initial: boolean }) {
  const [open, setOpen] = useState(initial)
  return (
    <>
      <button type="button" onClick={() => setOpen((o) => !o)}>
        toggle
      </button>
      <LazyDialogMount open={open}>
        <Lazy open={open} />
      </LazyDialogMount>
    </>
  )
}

test('never opened: renders nothing and never loads the dialog', async () => {
  loads = 0
  const { screen } = await renderWithProviders(<Harness initial={false} />)
  await expect.element(screen.getByRole('button', { name: 'toggle' })).toBeVisible()
  expect(screen.getByText(/shown|closing/).elements()).toHaveLength(0)
  expect(loads).toBe(0)
})

test('open: loads and renders the dialog; closed again: it stays mounted', async () => {
  loads = 0
  const { screen } = await renderWithProviders(<Harness initial={false} />)
  await screen.getByRole('button', { name: 'toggle' }).click()
  await expect.element(screen.getByText('shown')).toBeVisible()
  await screen.getByRole('button', { name: 'toggle' }).click()
  // Still mounted with open=false: Radix plays its exit animation, and reopening loads nothing.
  await expect.element(screen.getByText('closing')).toBeVisible()
  await screen.getByRole('button', { name: 'toggle' }).click()
  await expect.element(screen.getByText('shown')).toBeVisible()
  expect(loads).toBe(1)
})

test('open on first render (a URL deep link): the dialog renders', async () => {
  const { screen } = await renderWithProviders(<Harness initial />)
  await expect.element(screen.getByText('shown')).toBeVisible()
})
