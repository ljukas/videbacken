import { FLAG_CLASSES, SwedenFlag, UnitedKingdomFlag } from '~/components/flags'
import { Button } from '~/components/ui/button'
import { getLocale, type Locale, setLocale } from '~/paraglide/runtime'

// setLocale writes the oceanview-locale cookie and reloads the page — the
// whole document (loader data, query cache, <html lang>) re-renders
// server-side in the new locale, so no React state or provider is involved.

const FLAG_BY_LOCALE: Record<Locale, typeof SwedenFlag> = {
  sv: SwedenFlag,
  en: UnitedKingdomFlag,
}

// Pre-auth variant for the login page: one tap straight to the other
// language, labeled in that language so it reads as an exit for someone who
// doesn't understand the current one.
export function LocaleSwitcherInline() {
  const other: Locale = getLocale() === 'sv' ? 'en' : 'sv'
  const OtherFlag = FLAG_BY_LOCALE[other]
  return (
    <Button variant="ghost" size="sm" onClick={() => setLocale(other)}>
      <OtherFlag className={FLAG_CLASSES} />
      {other === 'en' ? 'In English' : 'På svenska'}
    </Button>
  )
}
