import { linkOptions } from '@tanstack/react-router'
import { HomeIcon, UserIcon, UsersIcon } from 'lucide-react'
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
    label: m.nav_home,
    keywords: m.cmd_kw_home,
    icon: HomeIcon,
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
    to: '/users',
    label: m.nav_users,
    keywords: m.cmd_kw_users,
    icon: UsersIcon,
    adminOnly: false,
  },
])

export type NavigateCommand = (typeof NAVIGATE_COMMANDS)[number]
