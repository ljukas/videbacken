# Admin section: move Inställningar to /admin/settings

**Goal:** Admin-only screens live in a sidebar **Admin** section that only admins see. Today that is one
screen, the settings page (data sources, sync history, car log import, tariffs, grid agreement,
credentials). It moves from `/charging/settings` (under Laddning) to `/admin/settings`.

**Agreed in chat (2026-11-04):**
- `/admin/settings` under the existing `/admin` guard (non-admins → `/`). The page's own admin check
  goes; the layout's guard covers it before any loader runs.
- Sidebar: an **Admin** item (shield icon), admins only, with sub-items like Laddning/Energi;
  Inställningar is its only sub-item. Removed from Laddning.
- `/admin` alone redirects to `/admin/settings` (no admin overview yet).
- Palette entry → new URL, label "Admininställningar" / "Admin settings", still admin-only.
- `/charging/settings` stays as a redirect-only route to `/admin/settings`, keeping the query
  (`?dialog=tariffNew`, `?dialog=credentials&source=…`), because already-sent emails link there.
- In-app links, new emails, and copy saying "Laddning → Inställningar" point at Admin.
- Unchanged: the page's behavior, `adminProcedure` mutations, Användare (`/users` stays open to members).

One step, one PR: `feat(admin): move settings into an admin-only section`.

## Tasks
1. Route move: `git mv` `charging/settings.tsx` → `admin/settings.tsx` (+ its browser test); drop the page's
   `beforeLoad`; `admin/index.tsx` redirects to `/admin/settings`; `charging/settings.tsx` becomes a
   redirect carrying the search. Test: the member case mounts the real `/admin` layout guard.
2. Sidebar + palette: Admin item with `adminSubItems`; every main item carries `adminOnly`; tests.
3. Links + copy: `SettingsLink`, three emails' `actionUrl`, i18n keys renamed `nav_admin_*`,
   `admin_settings_*`; "Laddning → Inställningar" → "Admin → Inställningar"; email/comment/test updates.
4. Tooling + docs: `captureBones.ts`, `measureBundle.ts`, CLAUDE.md code map, ADR-0015 amendment,
   ADR-0016 paths, `.env.example`.

## Reviewers
Core three + UI reviewer (`web-design-guidelines` + `vercel-react-best-practices`) + a permission-boundary
reviewer (the admin guard moved from the page to the layout).

## Review Focus
- The guard: a member must never run the settings loader (admin reads) via either URL.
- The old URL's redirect keeps `dialog`/`tariffId`/`source` and doesn't loop for members.
- Sidebar: Admin hidden for members, active states right on `/admin/settings`, Laddning no longer active there.
- No stale `/charging/settings` link left except the redirect route.
