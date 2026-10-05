import { expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { m } from '~/paraglide/messages'
import { SessionPagination } from './SessionPagination'

const noop = () => {}

const page = (n: number) => ({
  name: m.charging_sessions_pagination_page({ page: n }),
  exact: true,
})

test('hidden when every session fits on the smallest page', async () => {
  const { container } = await render(
    <SessionPagination
      page={1}
      pageSize={10}
      total={10}
      onPageChange={noop}
      onPageSizeChange={noop}
    />,
  )
  expect(container.childElementCount).toBe(0)
})

test('shown, with the size selector, once a larger size fits everything on one page', async () => {
  const screen = await render(
    <SessionPagination
      page={1}
      pageSize={25}
      total={11}
      onPageChange={noop}
      onPageSizeChange={noop}
    />,
  )
  await expect
    .element(screen.getByRole('combobox', { name: m.charging_sessions_pagination_page_size() }))
    .toBeVisible()
  await expect
    .element(screen.getByText(m.charging_sessions_pagination_range({ from: 1, to: 11, total: 11 })))
    .toBeVisible()
  await expect.element(screen.getByRole('button', page(1))).toHaveAttribute('aria-current', 'page')
})

test('labels the range on screen and marks the current page', async () => {
  const screen = await render(
    <SessionPagination
      page={2}
      pageSize={10}
      total={214}
      onPageChange={noop}
      onPageSizeChange={noop}
    />,
  )
  await expect
    .element(screen.getByRole('navigation', { name: m.charging_sessions_pagination_label() }))
    .toBeInTheDocument()
  await expect
    .element(
      screen.getByText(m.charging_sessions_pagination_range({ from: 11, to: 20, total: 214 })),
    )
    .toBeVisible()
  await expect.element(screen.getByRole('button', page(2))).toHaveAttribute('aria-current', 'page')
  await expect.element(screen.getByRole('button', page(3))).not.toHaveAttribute('aria-current')
  // The window around page 2, then the last page.
  await expect.element(screen.getByRole('button', page(22))).toBeInTheDocument()
  expect(screen.getByRole('button', page(6)).elements()).toHaveLength(0)
  await expect
    .element(screen.getByText(m.charging_sessions_pagination_position({ page: 2, count: 22 })))
    .toBeInTheDocument()
})

test('the last page ends its range at the total', async () => {
  const screen = await render(
    <SessionPagination
      page={22}
      pageSize={10}
      total={214}
      onPageChange={noop}
      onPageSizeChange={noop}
    />,
  )
  await expect
    .element(
      screen.getByText(m.charging_sessions_pagination_range({ from: 211, to: 214, total: 214 })),
    )
    .toBeVisible()
})

test('page links, previous and next ask for their page', async () => {
  const onPageChange = vi.fn()
  const screen = await render(
    <SessionPagination
      page={2}
      pageSize={10}
      total={214}
      onPageChange={onPageChange}
      onPageSizeChange={noop}
    />,
  )
  await screen.getByRole('button', page(3)).click()
  expect(onPageChange).toHaveBeenLastCalledWith(3)
  await screen.getByRole('button', { name: m.charging_sessions_pagination_next() }).click()
  expect(onPageChange).toHaveBeenLastCalledWith(3)
  await screen.getByRole('button', { name: m.charging_sessions_pagination_previous() }).click()
  expect(onPageChange).toHaveBeenLastCalledWith(1)
  await screen.getByRole('button', page(22)).click()
  expect(onPageChange).toHaveBeenLastCalledWith(22)
  // The current page is not a link to itself.
  await screen.getByRole('button', page(2)).click()
  expect(onPageChange).toHaveBeenCalledTimes(4)
})

test('previous is disabled on the first page, next on the last', async () => {
  const first = await render(
    <SessionPagination
      page={1}
      pageSize={10}
      total={30}
      onPageChange={noop}
      onPageSizeChange={noop}
    />,
  )
  await expect
    .element(first.getByRole('button', { name: m.charging_sessions_pagination_previous() }))
    .toBeDisabled()
  await expect
    .element(first.getByRole('button', { name: m.charging_sessions_pagination_next() }))
    .toBeEnabled()
  await first.unmount()

  const last = await render(
    <SessionPagination
      page={3}
      pageSize={10}
      total={30}
      onPageChange={noop}
      onPageSizeChange={noop}
    />,
  )
  await expect
    .element(last.getByRole('button', { name: m.charging_sessions_pagination_next() }))
    .toBeDisabled()
  await expect
    .element(last.getByRole('button', { name: m.charging_sessions_pagination_previous() }))
    .toBeEnabled()
})

test('the size selector offers 10, 25 and 50 and reports the chosen size', async () => {
  const onPageSizeChange = vi.fn()
  const screen = await render(
    <SessionPagination
      page={1}
      pageSize={10}
      total={214}
      onPageChange={noop}
      onPageSizeChange={onPageSizeChange}
    />,
  )
  const trigger = screen.getByRole('combobox', { name: m.charging_sessions_pagination_page_size() })
  await expect.element(trigger).toHaveTextContent('10')
  await trigger.click()
  await expect.element(screen.getByRole('option', { name: '50' })).toBeVisible()
  await screen.getByRole('option', { name: '25' }).click()
  expect(onPageSizeChange).toHaveBeenCalledWith(25)
})
