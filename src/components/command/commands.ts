import { linkOptions } from '@tanstack/react-router'
import { AnchorIcon, CalendarIcon, FolderIcon, Trash2Icon, UserIcon, UsersIcon } from 'lucide-react'
import { m } from '~/paraglide/messages'

// The palette's static navigate group. Same `linkOptions` + Lucide icon pattern
// as AppSidebar, so the `to` literals stay type-checked against the route tree.
// `label`/`keywords` are message *functions* called at render (locale is per
// render). Every item carries both `keywords` and `adminOnly` so the array has a
// single homogeneous shape — the role filter and substring match read them
// uniformly. `adminOnly` gating here is UX-only; routes still enforce auth.
export const NAVIGATE_COMMANDS = linkOptions([
  {
    to: '/',
    label: m.nav_calendar,
    keywords: m.cmd_kw_calendar,
    icon: CalendarIcon,
    adminOnly: false,
  },
  {
    to: '/owners',
    label: m.nav_owners,
    keywords: m.cmd_kw_owners,
    icon: UsersIcon,
    adminOnly: false,
  },
  {
    to: '/documents',
    label: m.nav_documents,
    keywords: m.cmd_kw_documents,
    icon: FolderIcon,
    adminOnly: false,
  },
  {
    to: '/account',
    label: m.nav_account,
    keywords: m.cmd_kw_account,
    icon: UserIcon,
    adminOnly: false,
  },
  {
    to: '/admin/shares',
    label: m.nav_shares,
    keywords: m.cmd_kw_shares,
    icon: AnchorIcon,
    adminOnly: true,
  },
  {
    to: '/admin/documents/bin',
    label: m.nav_bin,
    keywords: m.cmd_kw_bin,
    icon: Trash2Icon,
    adminOnly: true,
  },
])

export type NavigateCommand = (typeof NAVIGATE_COMMANDS)[number]
