import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { Empty, EmptyDescription, EmptyTitle } from '~/components/ui/empty'

test('Empty renders its title and description in the DOM', async () => {
  const screen = await render(
    <Empty>
      <EmptyTitle>Inga delägare än</EmptyTitle>
      <EmptyDescription>Bjud in den första delägaren.</EmptyDescription>
    </Empty>,
  )

  await expect.element(screen.getByText('Inga delägare än')).toBeVisible()
  await expect.element(screen.getByText('Bjud in den första delägaren.')).toBeVisible()
})
