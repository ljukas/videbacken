import { z } from 'zod'
import { getLocale } from '~/paraglide/runtime'

// Locale is resolved per issue rather than via a static z.config(z.locales.X())
// because the server handles requests in different locales concurrently —
// getLocale() reads Paraglide's per-request AsyncLocalStorage scope there,
// and the oceanview-locale cookie in the browser.
const localeErrors = {
  sv: z.locales.sv().localeError,
  en: z.locales.en().localeError,
}

z.config({ localeError: (issue) => localeErrors[getLocale()](issue) })
