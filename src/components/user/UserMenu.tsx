import { useSuspenseQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { LogOutIcon, MonitorIcon, MoonIcon, SunIcon, UserIcon } from 'lucide-react'
import type { ComponentProps, ComponentType } from 'react'
import { FLAG_CLASSES, SwedenFlag, UnitedKingdomFlag } from '~/components/flags'
import { useTheme } from '~/components/ThemeProvider'
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar'
import { Button } from '~/components/ui/button'
import { ButtonGroup } from '~/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '~/components/ui/sidebar'
import { useSignOut } from '~/lib/authClient'
import { orpc } from '~/lib/orpc/client'
import { initials } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { getLocale, type Locale, setLocale } from '~/paraglide/runtime'

function UserAvatar() {
  const { data: me } = useSuspenseQuery(orpc.user.me.queryOptions())
  const fallback = me.name.trim() ? initials(me.name) : (me.email[0]?.toUpperCase() ?? '?')

  return (
    <Avatar>
      {me.image ? (
        <AvatarImage
          src={me.image}
          alt={me.name}
          width={32}
          height={32}
          blurhash={me.imageBlurhash}
        />
      ) : null}
      <AvatarFallback>{fallback}</AvatarFallback>
    </Avatar>
  )
}

type SegmentedOption<T extends string> = {
  value: T
  label: string
  icon: ComponentType<{ className?: string }>
  iconClassName?: string
}

// A menu row whose value is changed in place: label on the left, a compact
// segmented button group on the right. Selecting the row never closes the
// menu — clicking the row (or Enter) cycles to the next option, the buttons
// jump straight to one, and ←/→ steps the value on the focused row (Radix
// menus close on Tab, so the buttons themselves stay out of the focus order
// and the a11y tree).
function SegmentedRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
}) {
  const active = options.find((option) => option.value === value)

  return (
    <DropdownMenuItem
      aria-label={`${label}: ${active?.label ?? value}`}
      onSelect={(event) => {
        event.preventDefault()
        const index = options.findIndex((option) => option.value === value)
        const next = options[(index + 1) % options.length]
        if (next) onChange(next.value)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        event.stopPropagation()
        const index = options.findIndex((option) => option.value === value)
        const next = options[index + (event.key === 'ArrowRight' ? 1 : -1)]
        if (next) onChange(next.value)
      }}
    >
      <span className="flex-1">{label}</span>
      {/* Outline buttons give the group its border and the dividers between
          items (the group merges adjacent borders), and keep border and fill
          on the same element so they stay pixel-aligned. Active = a
          translucent foreground fill: it must stay readable when the focused
          row paints itself bg-accent, which rules out the fixed grays
          (secondary/muted ≡ accent, so they vanish on hover) and a primary
          fill (the row's focus:**:text-accent-foreground repaint swallows
          the icon). The ! is needed to outrank outline's own bg-background /
          dark:bg-input/30 and hover:bg-muted. */}
      <ButtonGroup aria-hidden="true">
        {options.map((option) => (
          <Button
            key={option.value}
            type="button"
            size="xs"
            variant="outline"
            className={
              option.value === value ? 'bg-foreground/10! hover:bg-foreground/15!' : undefined
            }
            tabIndex={-1}
            onClick={(event) => {
              // Keep the click from bubbling to the row, which would cycle
              // right past the option just picked.
              event.stopPropagation()
              onChange(option.value)
            }}
          >
            <option.icon className={option.iconClassName} />
          </Button>
        ))}
      </ButtonGroup>
    </DropdownMenuItem>
  )
}

function ThemeRow() {
  const { theme, setTheme } = useTheme()

  return (
    <SegmentedRow
      label={m.user_menu_theme()}
      value={theme}
      onChange={setTheme}
      options={[
        { value: 'system', label: m.theme_system(), icon: MonitorIcon },
        { value: 'light', label: m.theme_light(), icon: SunIcon },
        { value: 'dark', label: m.theme_dark(), icon: MoonIcon },
      ]}
    />
  )
}

// setLocale writes the oceanview-locale cookie and reloads the page, so the
// menu closing on its own is moot.
function LanguageRow() {
  return (
    <SegmentedRow
      label={m.user_menu_language()}
      value={getLocale()}
      onChange={(locale: Locale) => setLocale(locale)}
      options={[
        // Endonyms — each language named in itself, readable whatever the
        // active locale is. Deliberately not in messages/*.json.
        { value: 'sv', label: 'Svenska', icon: SwedenFlag, iconClassName: FLAG_CLASSES },
        { value: 'en', label: 'English', icon: UnitedKingdomFlag, iconClassName: FLAG_CLASSES },
      ]}
    />
  )
}

function UserMenuContent({
  onNavigate,
  ...props
}: ComponentProps<typeof DropdownMenuContent> & { onNavigate?: () => void }) {
  const { data: me } = useSuspenseQuery(orpc.user.me.queryOptions())
  const signOut = useSignOut()
  const name = me.name.trim()

  return (
    <DropdownMenuContent {...props}>
      <DropdownMenuLabel className="font-normal">
        <div className="grid gap-0.5">
          <span className="truncate font-medium">{name || me.email}</span>
          {name ? <span className="truncate text-muted-foreground text-xs">{me.email}</span> : null}
        </div>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <Link to="/account/profile" onClick={onNavigate}>
          <UserIcon />
          {m.nav_account()}
        </Link>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <ThemeRow />
      <LanguageRow />
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => {
          void signOut()
        }}
      >
        <LogOutIcon />
        {m.nav_sign_out()}
      </DropdownMenuItem>
    </DropdownMenuContent>
  )
}

// Sidebar-footer trigger: avatar + name filling the row. In the collapsed
// icon rail the button shrinks to the avatar alone.
export function SidebarUserMenu() {
  const { data: me } = useSuspenseQuery(orpc.user.me.queryOptions())
  const { setOpenMobile } = useSidebar()

  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton size="lg">
            <UserAvatar />
            <span className="truncate font-medium">{me.name.trim() || me.email}</span>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <UserMenuContent
          side="top"
          align="start"
          className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
          onNavigate={() => setOpenMobile(false)}
        />
      </DropdownMenu>
    </SidebarMenuItem>
  )
}

// Mobile-header trigger: avatar only, same menu.
export function HeaderUserMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={m.user_menu_label()}
        className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <UserAvatar />
      </DropdownMenuTrigger>
      <UserMenuContent side="bottom" align="end" className="min-w-56" />
    </DropdownMenu>
  )
}
