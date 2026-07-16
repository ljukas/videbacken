import { createServerFn } from '@tanstack/react-start'
import { readTheme, themeSchema, writeTheme } from '~/lib/theme'

export const getTheme = createServerFn({ method: 'GET' }).handler(() => readTheme())

export const setThemeServerFn = createServerFn({ method: 'POST' })
  .validator(themeSchema)
  .handler(({ data }) => {
    writeTheme(data)
  })
