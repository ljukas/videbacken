import { Link, linkOptions, useMatchRoute } from '@tanstack/react-router'
import {
  AnchorIcon,
  CalendarIcon,
  FolderIcon,
  MapPinIcon,
  SearchIcon,
  Trash2Icon,
  UsersIcon,
} from 'lucide-react'
import { useCommandPalette } from '~/components/command/useCommandPalette'
import { Wordmark } from '~/components/Logo'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '~/components/ui/sidebar'
import { SidebarUserMenu } from '~/components/user/UserMenu'
import { useModKeyLabel } from '~/hooks/useModKeyLabel'
import { m } from '~/paraglide/messages'

type SidebarUser = {
  role?: string | null
}

// label is a message function rather than a string: module scope evaluates
// once per process, but the active locale is per request/render.
const mainNavItems = linkOptions([
  { to: '/', label: m.nav_calendar, icon: CalendarIcon },
  { to: '/owners', label: m.nav_owners, icon: UsersIcon },
  { to: '/recommendations', label: m.nav_recommendations, icon: MapPinIcon },
  { to: '/documents', label: m.nav_documents, icon: FolderIcon },
])

const adminNavItems = linkOptions([
  { to: '/admin/shares', label: m.nav_shares, icon: AnchorIcon },
  { to: '/admin/documents/bin', label: m.nav_bin, icon: Trash2Icon },
])

type NavItem = (typeof mainNavItems)[number] | (typeof adminNavItems)[number]

export function AppSidebar({ user }: { user: SidebarUser }) {
  const matchRoute = useMatchRoute()
  const { setOpenMobile } = useSidebar()
  const { setOpen: setCommandOpen } = useCommandPalette()
  const hotkeyLabel = useModKeyLabel()

  const isAdmin = user.role === 'admin'

  function renderItem(item: NavItem) {
    const isActive = !!matchRoute({ to: item.to, fuzzy: true })
    return (
      <SidebarMenuItem key={item.to}>
        <SidebarMenuButton asChild isActive={isActive} tooltip={item.label()}>
          <Link to={item.to} onClick={() => setOpenMobile(false)}>
            <item.icon />
            <span>{item.label()}</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
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
        {isAdmin ? (
          <SidebarGroup>
            <SidebarGroupLabel>{m.nav_admin_group()}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-1">{adminNavItems.map(renderItem)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
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
