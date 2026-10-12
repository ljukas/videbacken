import { expect, test } from 'vitest'
import { HEAT_PUMP_COLORS, heatPumpColor } from './heatPumpColors'

const units = [{ id: 'hp-a' }, { id: 'hp-b' }, { id: 'hp-c' }, { id: 'hp-d' }]

test('a unit’s colour is its place in the all-time order', () => {
  expect(heatPumpColor(units, 'hp-a')).toBe('var(--energy-heat-pump-1)')
  expect(heatPumpColor(units, 'hp-b')).toBe('var(--energy-heat-pump-2)')
  expect(heatPumpColor(units, 'hp-c')).toBe('var(--energy-heat-pump-3)')
  expect(HEAT_PUMP_COLORS).toHaveLength(3)
})

test('a fourth unit or an unknown id is neutral, never a cycled colour', () => {
  expect(heatPumpColor(units, 'hp-d')).toBe('var(--muted-foreground)')
  expect(heatPumpColor(units, 'nope')).toBe('var(--muted-foreground)')
})
