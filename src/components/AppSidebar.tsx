import { Link, linkOptions, useMatchRoute } from '@tanstack/react-router'
import { HomeIcon, SearchIcon, ThermometerIcon, UsersIcon, ZapIcon } from 'lucide-react'
import { useCommandPalette } from '~/components/command/useCommandPalette'
import { Wordmark } from '~/components/Logo'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '~/components/ui/sidebar'
import { SidebarUserMenu } from '~/components/user/UserMenu'
import { useModKeyLabel } from '~/hooks/useModKeyLabel'
import { m } from '~/paraglide/messages'

// label is a message function rather than a string: module scope evaluates
// once per process, but the active locale is per request/render.
const chargingSubItems = linkOptions([
  { to: '/charging', label: m.nav_charging_overview },
  { to: '/charging/patterns', label: m.nav_charging_patterns_short },
])

const mainNavItems = linkOptions([
  { to: '/', label: m.nav_home, icon: HomeIcon },
  { to: '/sensors', label: m.nav_sensors, icon: ThermometerIcon },
  { to: '/charging', label: m.nav_charging, icon: ZapIcon, subItems: chargingSubItems },
  { to: '/users', label: m.nav_users, icon: UsersIcon },
])

type NavItem = (typeof mainNavItems)[number]
type NavSubItem = (typeof chargingSubItems)[number]

// Links into a section with sub-views. Link sets aria-current itself from its
// own match, prefix by default, so it must be exact or /charging would read as
// the current page on /charging/patterns too. The views' own params (month,
// metric, dialog) mustn't count, so search is ignored for the match. The chosen
// year is kept when switching between the views.
const sectionLinkProps = {
  search: (prev: { year?: number }) => ({ year: prev.year }),
  activeOptions: { exact: true, includeSearch: false },
} as const

export function AppSidebar() {
  const matchRoute = useMatchRoute()
  const { setOpenMobile } = useSidebar()
  const { setOpen: setCommandOpen } = useCommandPalette()
  const hotkeyLabel = useModKeyLabel()

  function renderItem(item: NavItem) {
    const isActive = !!matchRoute({ to: item.to, fuzzy: true })
    return (
      <SidebarMenuItem key={item.to}>
        <SidebarMenuButton asChild isActive={isActive} tooltip={item.label()}>
          <Link
            to={item.to}
            {...('subItems' in item ? sectionLinkProps : {})}
            onClick={() => setOpenMobile(false)}
          >
            <item.icon />
            <span>{item.label()}</span>
          </Link>
        </SidebarMenuButton>
        {'subItems' in item ? (
          <SidebarMenuSub>{item.subItems.map(renderSubItem)}</SidebarMenuSub>
        ) : null}
      </SidebarMenuItem>
    )
  }

  // Sibling views of one section. Matched exactly (see sectionLinkProps): the
  // overview's /charging is a prefix of /charging/patterns.
  function renderSubItem(item: NavSubItem) {
    const isActive = !!matchRoute({ to: item.to })
    return (
      <SidebarMenuSubItem key={item.to}>
        <SidebarMenuSubButton asChild isActive={isActive}>
          <Link to={item.to} {...sectionLinkProps} onClick={() => setOpenMobile(false)}>
            <span>{item.label()}</span>
          </Link>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    )
  }

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader className="gap-2 px-2 py-3">
        <Wordmark className="group-data-[collapsible=icon]:justify-center" />
        {/* Desktop rail only: on mobile the search lives in the header bar
            (the sidebar is a drawer behind the hamburger). */}
        <SidebarMenu className="hidden md:flex">
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => {
                setOpenMobile(false)
                setCommandOpen(true)
              }}
              tooltip={m.cmd_trigger_label()}
              className="text-muted-foreground"
            >
              <SearchIcon />
              <span>{m.cmd_trigger_label()}</span>
              {hotkeyLabel ? (
                <kbd className="pointer-events-none ml-auto hidden h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] group-data-[collapsible=icon]:hidden sm:inline-flex">
                  {hotkeyLabel}
                </kbd>
              ) : null}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">{mainNavItems.map(renderItem)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      {/* Hidden below md: the mobile header already shows HeaderUserMenu,
          so the drawer would duplicate it. */}
      <SidebarFooter className="hidden md:flex">
        <SidebarMenu>
          <SidebarUserMenu />
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
