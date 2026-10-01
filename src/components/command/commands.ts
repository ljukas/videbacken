import { linkOptions } from '@tanstack/react-router'
import {
  CalendarClockIcon,
  HomeIcon,
  PiggyBankIcon,
  ThermometerIcon,
  UserIcon,
  UsersIcon,
  ZapIcon,
} from 'lucide-react'
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
    to: '/sensors',
    label: m.nav_sensors,
    keywords: m.cmd_kw_sensors,
    icon: ThermometerIcon,
    adminOnly: false,
  },
  {
    to: '/charging',
    label: m.nav_charging,
    keywords: m.cmd_kw_charging,
    icon: ZapIcon,
    adminOnly: false,
  },
  {
    to: '/charging/patterns',
    label: m.nav_charging_patterns,
    keywords: m.cmd_kw_charging_patterns,
    icon: CalendarClockIcon,
    adminOnly: false,
  },
  {
    to: '/charging/economy',
    label: m.nav_charging_economy,
    keywords: m.cmd_kw_charging_economy,
    icon: PiggyBankIcon,
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
