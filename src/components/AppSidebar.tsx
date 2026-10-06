import { Link, linkOptions, useMatchRoute } from '@tanstack/react-router'
import { HomeIcon, SearchIcon, SunIcon, ThermometerIcon, UsersIcon, ZapIcon } from 'lucide-react'
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
import type { VehicleScope } from '~/lib/evCharging/vehicle'
import { m } from '~/paraglide/messages'

// label is a message function rather than a string: module scope evaluates
// once per process, but the active locale is per request/render. `link` picks the
// props a view's Link gets: charging views share the page filter (year, vehicle),
// energy views the period, settings is admin-only and unscoped. Every item carries
// both `link` and `adminOnly`, so each array keeps one shape.
const chargingSubItems = linkOptions([
  { to: '/charging', label: m.nav_charging_overview, link: 'charging', adminOnly: false },
  {
    to: '/charging/patterns',
    label: m.nav_charging_patterns_short,
    link: 'charging',
    adminOnly: false,
  },
  {
    to: '/charging/economy',
    label: m.nav_charging_economy_short,
    link: 'charging',
    adminOnly: false,
  },
  {
    to: '/charging/settings',
    label: m.nav_charging_settings_short,
    link: 'unscoped',
    adminOnly: true,
  },
])

const energySubItems = linkOptions([
  { to: '/energy', label: m.nav_energy_overview, link: 'energy', adminOnly: false },
  { to: '/energy/battery', label: m.nav_energy_battery, link: 'energy', adminOnly: false },
])

const mainNavItems = linkOptions([
  { to: '/', label: m.nav_home, icon: HomeIcon },
  { to: '/sensors', label: m.nav_sensors, icon: ThermometerIcon },
  {
    to: '/charging',
    label: m.nav_charging,
    icon: ZapIcon,
    subItems: chargingSubItems,
    link: 'charging',
  },
  { to: '/energy', label: m.nav_energy, icon: SunIcon, subItems: energySubItems, link: 'energy' },
  { to: '/users', label: m.nav_users, icon: UsersIcon },
])

type NavItem = (typeof mainNavItems)[number]
type NavSubItem = (typeof chargingSubItems)[number] | (typeof energySubItems)[number]

// Links into a section with sub-views. Link sets aria-current itself from its
// own match, prefix by default, so it must be exact or /charging (and /energy)
// would read as the current page on its views too. The views' own params (month,
// metric, dialog) mustn't count, so search is ignored for the match.
const activeOptions = { exact: true, includeSearch: false } as const
// Charging views keep the chosen year and vehicle scope (the page filter, ADR-0021) between them.
const chargingLinkProps = {
  search: (prev: { year?: number; vehicle?: VehicleScope }) => ({
    year: prev.year,
    vehicle: prev.vehicle,
  }),
  activeOptions,
} as const
// Energi views keep the chosen period (?period=); they have no year or vehicle filter.
const energyLinkProps = {
  search: (prev: { period?: string | number }) => ({ period: prev.period }),
  activeOptions,
} as const
// Settings: matched exactly like the views, but it starts from a clean URL.
const unscopedLinkProps = { search: () => ({}), activeOptions } as const
const LINK_PROPS = {
  charging: chargingLinkProps,
  energy: energyLinkProps,
  unscoped: unscopedLinkProps,
} as const

export function AppSidebar({ role }: { role?: string | null } = {}) {
  // UX-only filter, like the palette's; the route enforces access.
  const isAdmin = role === 'admin'
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
            {...('subItems' in item ? LINK_PROPS[item.link] : {})}
            onClick={() => setOpenMobile(false)}
          >
            <item.icon />
            <span>{item.label()}</span>
          </Link>
        </SidebarMenuButton>
        {'subItems' in item ? (
          <SidebarMenuSub>
            {item.subItems.filter((s) => isAdmin || !s.adminOnly).map(renderSubItem)}
          </SidebarMenuSub>
        ) : null}
      </SidebarMenuItem>
    )
  }

  // Sibling views of one section. Matched exactly (see LINK_PROPS): the
  // overview's /charging is a prefix of /charging/patterns.
  function renderSubItem(item: NavSubItem) {
    const isActive = !!matchRoute({ to: item.to })
    return (
      <SidebarMenuSubItem key={item.to}>
        <SidebarMenuSubButton asChild isActive={isActive}>
          <Link to={item.to} {...LINK_PROPS[item.link]} onClick={() => setOpenMobile(false)}>
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
