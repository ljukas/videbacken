import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { useTheme } from '~/components/ThemeProvider'
import { Button } from '~/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import type { Theme } from '~/lib/theme'
import { m } from '~/paraglide/messages'

// Standalone theme control: a ghost icon button whose sun/moon glyph reflects
// the *resolved* appearance (keyed on the .dark class, so it's right whether the
// preference is light/dark/system), opening a 3-option radio menu. Reuses
// useTheme() — no cookie/SSR logic here. Used pre-auth on /login; reusable
// anywhere outside the authenticated UserMenu (which keeps its own SegmentedRow).
export function ModeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon">
          <SunIcon className="rotate-0 scale-100 transition-transform dark:-rotate-90 dark:scale-0" />
          <MoonIcon className="absolute rotate-90 scale-0 transition-transform dark:rotate-0 dark:scale-100" />
          <span className="sr-only">{m.theme_toggle_label()}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
          <DropdownMenuRadioItem value="system">
            <MonitorIcon />
            {m.theme_system()}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">
            <SunIcon />
            {m.theme_light()}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <MoonIcon />
            {m.theme_dark()}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
