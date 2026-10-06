import { expect, test } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { MetricToggle } from './MetricToggle'

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
]

test('items keep the compact sm sizing by default', async () => {
  const { screen } = await renderWithProviders(
    <MetricToggle value="a" options={options} onChange={() => {}} aria-label="Metric" />,
  )
  const cls = screen.getByRole('radio', { name: 'Alpha' }).element().className
  expect(cls).toContain('h-7')
  expect(cls).toContain('text-[0.8rem]')
})

test('itemClassName opts the items into a larger size', async () => {
  const { screen } = await renderWithProviders(
    <MetricToggle
      value="a"
      options={options}
      onChange={() => {}}
      aria-label="Metric"
      itemClassName="h-10 px-4 text-sm"
    />,
  )
  const cls = screen.getByRole('radio', { name: 'Alpha' }).element().className
  expect(cls).toContain('h-10')
  expect(cls).toContain('text-sm')
  expect(cls).not.toContain('h-7')
  expect(cls).not.toContain('text-[0.8rem]')
})
