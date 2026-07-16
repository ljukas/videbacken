# Recommended Places — Slice 2: Map + Detail (Read-Only) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the read-only surface of Recommended Places (ADR-0012) — a `/recommendations` route hosting a **client-only MapLibre map** of photo **orbs** plus a **detail dialog** (photo carousel + metadata + tag chips, **no social yet**), a sidebar nav entry, and the tag-label foundation — all consuming Slice 1's data backbone unchanged except for one additive read-enrichment.

**Architecture:** The map is a client-only MapLibre GL component (`@vis.gl/react-maplibre`) over MapTiler satellite tiles, lazy-loaded inside TanStack Router's `<ClientOnly>` so it never enters the SSR bundle. Orbs are memoized cover-photo `<Marker>`s; tapping one opens a `ResponsiveDialog` whose open state lives in the URL (`?place=<id>`, ADR-0013). Photos ride the existing avatar byte-path — one stored original per `file`, rendered at on-demand sizes via the `unpic` transformer with a blurhash placeholder (exactly `AvatarImage`). The one backbone change: Slice 1's `list`/`get` procedures return photo **pathnames**, but the `unpic` transformer needs **URLs**, so this slice enriches the read procedures with `storage.getReadUrl('public', …)` — `coverUrl` on list items, `photos[].url` on the single-item `get`. Tags render as chips via a `slug → m.tag_<slug>()` registry; the map's tag-**filter** row is deferred to Slice 6.

**Tech Stack:** `@vis.gl/react-maplibre` + `maplibre-gl` (client-only WebGL map), MapTiler tiles, shadcn `carousel` (embla-carousel-react), `@unpic/react` + `@unpic/placeholder` (already deps), TanStack Router (`ClientOnly`, search-param dialog state) + TanStack Query, shadcn/ui, Tailwind v4, Paraglide i18n.

**Companion docs (read first):**
- Design: [`docs/adr/0012-recommended-places.md`](../../adr/0012-recommended-places.md) (esp. Decision §§1–4, §8, §10 and the build-sequence table — Slice 2 row).
- **Seam map (cited as "seam map §N"):** [`00-seam-map.md`](./00-seam-map.md).
- **Slice 1 (the backbone this consumes):** [`01-data-backbone.md`](./01-data-backbone.md).
- Forms-as-overlays + URL dialog state: [`docs/adr/0013-form-presentation-and-dialog-architecture.md`](../../adr/0013-form-presentation-and-dialog-architecture.md).
- Layout/width + visual identity: [`docs/adr/0015-visual-identity-and-design-language.md`](../../adr/0015-visual-identity-and-design-language.md).
- Empty states: [`docs/adr/0016-empty-state-and-feedback-conventions.md`](../../adr/0016-empty-state-and-feedback-conventions.md).

## Global Constraints

Every task implicitly includes these (CLAUDE.md Non-negotiables + the ADRs above):

- **New npm dependencies are allowed in this slice** — and only these three: `maplibre-gl`, `@vis.gl/react-maplibre`, and `embla-carousel-react` (pulled in by `shadcn add carousel`). No others.
- **The map is client-only (no SSR).** MapLibre needs `window`/WebGL. Render it via `React.lazy(() => import('…/RecommendationMap'))` **inside** TanStack Router's `<ClientOnly fallback={…}>` (`@tanstack/react-router`). Never import `maplibre-gl` or `@vis.gl/react-maplibre` at the top level of an SSR-reachable module. `import 'maplibre-gl/dist/maplibre-gl.css'` lives at the top of `RecommendationMap.tsx` (the lazy, client-only module). We deliberately do **not** touch `vite.config.ts` `ssr.external` (the config is Nitro/Rolldown and exposes no such block; `ClientOnly` + `lazy` is the idiomatic, sufficient path — ADR-0012 §1 names lazy-import as the accepted alternative).
- **`VITE_MAPTILER_API_KEY` is required for the map to render.** It is **client-exposed by nature** (the browser fetches the style JSON) and therefore **not a secret** — restrict it by HTTP-referrer in the MapTiler dashboard. Read it as `import.meta.env.VITE_MAPTILER_API_KEY`. Live verification needs a real key in the local `.env` (gitignored); `.env.example` documents it.
- **Read-only slice.** No create/edit/reorder/like/comment UI. The only backbone change is the additive URL enrichment on the existing `list`/`get` procedures (Task 3). All DB access stays in services; services never import effects, so the URL enrichment lives in the **procedure** (glue), not the service (ADR-0001/0002).
- **Reuse the avatar byte-path verbatim** — `@unpic/react` `Image` + `~/lib/image/transformer` + `~/lib/image/sizes` `snapBreakpoints` + `@unpic/placeholder` blurhash gradient (canonical: `src/components/ui/avatar.tsx:43–86`). No new storage code, no thumbnail worker.
- **Realtime is already wired** (Slice 1 added `recommendation.changed` → `invalidateQueries(orpc.recommendation.key())` in `src/hooks/useRealtimeSync.ts`). This slice adds nothing to realtime; create/like/etc. from later slices will invalidate these reads automatically.
- **Responsive on every screen** (CLAUDE.md): near-full-height map on mobile with a touch-sized `NavigationControl` and ≥44px orb hit targets; bounded height on desktop. No fixed pixel widths.
- **i18n via Paraglide** — all strings in `messages/sv.json` (source of truth, informal "du") + `messages/en.json` (key-complete). Store the message **function** at module scope, call it at render. After editing messages outside `pnpm dev`, run `pnpm i18n:compile`. Route URL stays English (`/recommendations`).
- **Component placement & naming**: feature components in `src/components/recommendation/` (PascalCase); the route file is `src/routes/_authenticated/recommendations.tsx`. `src/components/ui/` is shadcn-managed (kebab-case) — don't normalize.
- **Conventional Commits** per task.

**Tag UI scope (decided):** detail-dialog **chips only**. This slice builds `tagLabels.ts` + the 10 `tag_<slug>` messages + `<TagChip>`. The map's tag-**filter** chip row (ADR-0012 §UI surface) is **Slice 6** (it shares this registry).

**Out of scope (later slices — do not build):** create/edit editor + EXIF + `geo.ts`/Haversine (Slice 3); likes + orb premiering (Slice 4); comments (Slice 5); list view, map⇄list toggle, sorts, and the map tag-filter row (Slice 6).

---

## File Structure

**Create:**
- `src/components/recommendation/tagLabels.ts` — `TagSlug` union + `tagLabels` registry (`slug → () => string`).
- `src/components/recommendation/tagLabels.test.ts` — DB-backed exhaustiveness test (every seeded slug has a label).
- `src/components/recommendation/TagChip.tsx` — a `Badge` rendering one tag's localized label.
- `src/components/recommendation/RecommendationImage.tsx` — the `unpic` `Image` + blurhash wrapper (rectangular/round via className).
- `src/components/recommendation/RecommendationMap.tsx` — the **client-only, lazy** MapLibre map (orbs + fit-to-places + `NavigationControl`).
- `src/components/recommendation/RecommendationDetailDialog.tsx` — `ResponsiveDialog` with photo carousel + metadata + tag chips.
- `src/routes/_authenticated/recommendations.tsx` — the route (map host + detail dialog + empty state).

**Modify:**
- `src/lib/orpc/procedures/recommendation.ts` — enrich `list` (`coverUrl`) and `get` (`photos[].url`) with public read URLs.
- `src/components/AppSidebar.tsx` — add the `/recommendations` nav item (`MapPinIcon`, `m.nav_recommendations`).
- `src/components/ui/carousel.tsx` — **added by `shadcn add carousel`** (CLI-generated; not hand-written).
- `package.json` / `pnpm-lock.yaml` — `maplibre-gl`, `@vis.gl/react-maplibre`, `embla-carousel-react`.
- `.env.example` — document `VITE_MAPTILER_API_KEY`.
- `messages/sv.json`, `messages/en.json` — 10 `tag_<slug>` keys + `nav_recommendations` + `meta_recommendations_*` + `recommendations_*` + `recommendation_recommended_by` + `recommendation_photo_alt` + `recommendation_map_loading`.

**Dependency spine (task order):** deps + env (1) → tag labels + chip (2) → read-URL enrichment (3) → image + map components (4) → route + nav + i18n + empty (5) → detail dialog + carousel (6) → wrap-up + live verification (7).

**Review checkpoints (feature-workflow Phase 5):** no DB migration in this slice, so **migration-guard is N/A**. Run the `test-completeness` agent after Task 2 (the one new test). Run `vercel:react-best-practices` after Tasks 4–6 (multiple new TSX components). Run the `code-reviewer` agent + `pnpm check:ci && pnpm build && pnpm test:node` before opening the slice PR, plus the **live browser verification** in Task 7 (the map/dialog can't be covered by the browser-mode harness — it still lacks `RouterProvider`, and MapLibre needs real WebGL; see `test/browser/README.md`).

---

## Task 1: Dependencies + MapTiler env

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (via `pnpm add` / `shadcn add`)
- Create: `src/components/ui/carousel.tsx` (CLI-generated)
- Modify: `.env.example`

**Interfaces:**
- Produces: `maplibre-gl` + `@vis.gl/react-maplibre` importable; shadcn `Carousel`/`CarouselContent`/`CarouselItem`/`CarouselPrevious`/`CarouselNext`/`type CarouselApi` exported from `~/components/ui/carousel`; `VITE_MAPTILER_API_KEY` documented.

- [ ] **Step 1: Add the map dependencies**

Run: `pnpm add maplibre-gl @vis.gl/react-maplibre`
Expected: both added to `dependencies` in `package.json`; lockfile updated.

- [ ] **Step 2: Add the shadcn carousel (pulls embla)**

Run: `pnpm dlx shadcn@latest add carousel`
Expected: `src/components/ui/carousel.tsx` created; `embla-carousel-react` added to `dependencies`. The CLI rewrites imports to the project `~/` alias and uses the project icon library (lucide). **Read the generated file** and confirm it imports `~/lib/utils` `cn` and `~/components/ui/button`, and exports `Carousel, CarouselContent, CarouselItem, CarouselPrevious, CarouselNext, type CarouselApi`. Fix any `@/` paths if present (per the shadcn skill, third-party rewrites can miss).

- [ ] **Step 3: Document the MapTiler key in `.env.example`**

Append to `.env.example` (model the comment style on the existing storage blocks):

```sh
# --- Maps (Recommended Places, ADR-0012) ---
# MapTiler tile API key. CLIENT-EXPOSED BY NATURE: the browser fetches the map
# style JSON, so this is NOT a secret (unlike NEON_API_KEY / BETTER_AUTH_SECRET).
# Restrict it by HTTP-referrer in the MapTiler dashboard. Get one free at
# https://cloud.maptiler.com (Account -> Keys). Vite exposes only VITE_-prefixed
# vars to the client. The map renders blank without it.
VITE_MAPTILER_API_KEY=
```

- [ ] **Step 4: Put a real key in your local `.env` (do NOT commit)**

Add `VITE_MAPTILER_API_KEY=<your-key>` to the gitignored `.env` so `pnpm dev` renders tiles in Task 5+ verification. Never commit a real key.

- [ ] **Step 5: Typecheck/build**

Run: `pnpm build`
Expected: `tsc --noEmit` + Vite build pass. (No map is rendered yet; this only confirms the new deps resolve and don't break the SSR build.)

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/components/ui/carousel.tsx .env.example
git commit -m "chore(recommendation): add maplibre + react-maplibre + carousel deps, document MapTiler key"
```

---

## Task 2: Tag labels — registry, messages, chip, exhaustiveness test

**Files:**
- Create: `src/components/recommendation/tagLabels.ts`, `src/components/recommendation/TagChip.tsx`, `src/components/recommendation/tagLabels.test.ts`
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Produces: `TAG_SLUGS` (readonly tuple), `type TagSlug`, `tagLabels: Record<TagSlug, () => string>`, `isTagSlug(s: string): s is TagSlug` from `~/components/recommendation/tagLabels`; `<TagChip slug={TagSlug} />` from `~/components/recommendation/TagChip`.

- [ ] **Step 1: Add the 10 tag messages to `messages/sv.json`** (source of truth; informal "du")

Insert (keep the file's alphabetical-ish grouping near the other `recommendation_*` keys):

```json
"tag_restaurant": "Restaurang",
"tag_anchorage": "Ankarplats",
"tag_pier": "Brygga",
"tag_cove": "Vik",
"tag_beach": "Strand",
"tag_marina": "Marina",
"tag_bar": "Bar",
"tag_snorkeling": "Snorkling",
"tag_provisioning": "Proviantering",
"tag_viewpoint": "Utsiktsplats",
```

- [ ] **Step 2: Add the same keys to `messages/en.json`** (must stay key-complete)

```json
"tag_restaurant": "Restaurant",
"tag_anchorage": "Anchorage",
"tag_pier": "Pier",
"tag_cove": "Cove",
"tag_beach": "Beach",
"tag_marina": "Marina",
"tag_bar": "Bar",
"tag_snorkeling": "Snorkeling",
"tag_provisioning": "Provisioning",
"tag_viewpoint": "Viewpoint",
```

- [ ] **Step 3: Compile messages**

Run: `pnpm i18n:compile`
Expected: `src/paraglide/messages` regenerated; `m.tag_restaurant` … `m.tag_viewpoint` now exist and typecheck.

- [ ] **Step 4: Write the registry**

Create `src/components/recommendation/tagLabels.ts`. The slugs mirror `drizzle/0016_seed_system_tags.sql` exactly; the `Record<TagSlug, …>` makes a missing label a **compile error**.

```ts
import { m } from '~/paraglide/messages'

// The fixed, curated tag vocabulary seeded by drizzle/0016_seed_system_tags.sql.
// Order here is irrelevant — display order comes from tag.sortOrder; this registry
// only maps slug -> localized label. A new seeded slug without a label here is a
// TYPE error (Record key) and is also caught at runtime by tagLabels.test.ts.
export const TAG_SLUGS = [
  'restaurant',
  'anchorage',
  'pier',
  'cove',
  'beach',
  'marina',
  'bar',
  'snorkeling',
  'provisioning',
  'viewpoint',
] as const

export type TagSlug = (typeof TAG_SLUGS)[number]

export const tagLabels: Record<TagSlug, () => string> = {
  restaurant: m.tag_restaurant,
  anchorage: m.tag_anchorage,
  pier: m.tag_pier,
  cove: m.tag_cove,
  beach: m.tag_beach,
  marina: m.tag_marina,
  bar: m.tag_bar,
  snorkeling: m.tag_snorkeling,
  provisioning: m.tag_provisioning,
  viewpoint: m.tag_viewpoint,
}

export function isTagSlug(slug: string): slug is TagSlug {
  return slug in tagLabels
}
```

- [ ] **Step 5: Write the chip**

Create `src/components/recommendation/TagChip.tsx` (uses the already-installed `Badge`; semantic variant, no raw colors):

```tsx
import { Badge } from '~/components/ui/badge'
import { type TagSlug, tagLabels } from './tagLabels'

export function TagChip({ slug }: { slug: TagSlug }) {
  return <Badge variant="secondary">{tagLabels[slug]()}</Badge>
}
```

- [ ] **Step 6: Write the exhaustiveness test** (the registry must cover every *seeded* slug — catches a future seed-without-label)

Create `src/components/recommendation/tagLabels.test.ts`:

```ts
import { expect, test } from 'vitest'
import { setupDatabase } from '~test/setup'
import * as tagService from '~/lib/services/tag'
import { isTagSlug, TAG_SLUGS, tagLabels } from './tagLabels'

setupDatabase()

test('every seeded tag slug has a label entry', async () => {
  const tags = await tagService.listTags()
  expect(tags.length).toBeGreaterThan(0)
  for (const t of tags) {
    expect(isTagSlug(t.slug), `seeded slug "${t.slug}" missing from tagLabels`).toBe(true)
  }
})

test('the registry declares no slugs that are not seeded', async () => {
  const seeded = new Set((await tagService.listTags()).map((t) => t.slug))
  for (const slug of TAG_SLUGS) {
    expect(seeded.has(slug), `tagLabels slug "${slug}" is not seeded`).toBe(true)
  }
})

test('every label is callable and returns a non-empty string', () => {
  for (const slug of TAG_SLUGS) {
    expect(tagLabels[slug]()).toBeTruthy()
  }
})
```

- [ ] **Step 7: Run the test**

Run: `pnpm test:node -- tagLabels`
Expected: 3 tests pass (the per-test schema runs migration `0016_seed_system_tags`, so `listTags()` returns the 10 tags).

- [ ] **Step 8: Commit**

```bash
git add src/components/recommendation/tagLabels.ts src/components/recommendation/TagChip.tsx src/components/recommendation/tagLabels.test.ts messages/sv.json messages/en.json src/paraglide
git commit -m "feat(recommendation): add tag label registry, chip, and seeded-slug test"
```

---

## Task 3: Enrich read procedures with public photo URLs

The avatar path renders from a **stored URL** (`confirmAvatarUpload` saves `blob.url` onto `user.image`). Recommendation photos have no such denormalized URL — Slice 1's `list`/`get` return only `file.pathname`. The `unpic` transformer needs a URL, so the **procedure** (glue — allowed to use effects; the service is not) maps pathname → public read URL via `storage.getReadUrl('public', …)`. To bound cost, `list` enriches only the **cover** (one URL per place); `get` enriches **all** photos.

**Files:**
- Modify: `src/lib/orpc/procedures/recommendation.ts`

**Interfaces:**
- Produces (client-visible payload changes, flow through oRPC type inference):
  - `recommendation.list` items gain `coverUrl: string | null` (the lowest-`sortOrder` photo's public URL; `null` only if a place somehow has no photos).
  - `recommendation.get` items gain `photos[].url: string` on every photo.

- [ ] **Step 1: Add a public-URL helper + enrich `list` and `get`**

Edit `src/lib/orpc/procedures/recommendation.ts`. `storage` is already imported (`import { … storage } from '~/lib/effects'`). Add near the top (after imports):

```ts
// Public read URL for a stored pathname. For the public store getReadUrl returns
// a stable URL (vercelBlob: head().url; s3: deterministic) — ttl is unused. One
// network head per call in prod; fine at this scale (dozens of places). Revisit
// trigger: denormalize a url column if list latency ever matters (ADR-0012).
const PUBLIC_URL_TTL_SECONDS = 3600
function publicPhotoUrl(pathname: string): Promise<string> {
  return storage.getReadUrl('public', pathname, PUBLIC_URL_TTL_SECONDS)
}
```

Replace the `list` handler:

```ts
  list: protectedProcedure.handler(async () => {
    const items = await listRecommendations()
    // Only the cover (lowest sort_order = photos[0], already ordered) is shown on
    // the map/list, so enrich just that one per place to keep heads bounded.
    return Promise.all(
      items.map(async (item) => ({
        ...item,
        coverUrl: item.photos[0] ? await publicPhotoUrl(item.photos[0].pathname) : null,
      })),
    )
  }),
```

Replace the `get` handler (keep the existing NOT_FOUND mapping; enrich after a successful find):

```ts
  get: protectedProcedure
    .errors(recommendationErrors)
    .input(z.object({ id: z.string().uuid() }))
    .handler(async ({ input, errors }) => {
      let item: Awaited<ReturnType<typeof findRecommendation>>
      try {
        item = await findRecommendation(input.id)
      } catch (err) {
        if (err instanceof RecommendationDomainError) throw errors[err.code]()
        throw err
      }
      const photos = await Promise.all(
        item.photos.map(async (p) => ({ ...p, url: await publicPhotoUrl(p.pathname) })),
      )
      return { ...item, photos }
    }),
```

- [ ] **Step 2: Typecheck**

Run: `pnpm build`
Expected: passes. The client `orpc.recommendation.list`/`get` output types now include `coverUrl` / `photos[].url` (verify by hovering the inferred type, or it surfaces as a type error in Tasks 4–6 if mismatched).

- [ ] **Step 3: Commit**

```bash
git add src/lib/orpc/procedures/recommendation.ts
git commit -m "feat(recommendation): enrich list/get reads with public photo URLs"
```

> **Verification note:** procedures have no unit-test harness here (tests are service-level). The `devLog` storage adapter used in tests returns a string from `getReadUrl`, so this can't crash there; correctness is confirmed by typecheck (Step 2) and the live browser checks in Task 7.

---

## Task 4: RecommendationImage + the client-only RecommendationMap

**Files:**
- Create: `src/components/recommendation/RecommendationImage.tsx`, `src/components/recommendation/RecommendationMap.tsx`

**Interfaces:**
- Consumes: `orpc.recommendation.list` items (`{ id, title, lat, lng, coverUrl, photos: [{ blurhash, … }], … }`); `VITE_MAPTILER_API_KEY`.
- Produces: `<RecommendationImage src blurhash alt width height className />`; `RecommendationMap` as the **default export** of `RecommendationMap.tsx` (so the route can `React.lazy(() => import('…/RecommendationMap'))`), props `{ places: RecommendationListItem[]; onSelect: (id: string) => void }`.

- [ ] **Step 1: Write the image wrapper** (the avatar `Image` pattern, decoupled from the round avatar box)

Create `src/components/recommendation/RecommendationImage.tsx`:

```tsx
import { blurhashToCssGradientString } from '@unpic/placeholder'
import { Image } from '@unpic/react/base'
import { useMemo } from 'react'
import { snapBreakpoints } from '~/lib/image/sizes'
import { transformer } from '~/lib/image/transformer'
import { cn } from '~/lib/utils'

// Renders a public-store image at an on-demand size with a blurhash placeholder,
// reusing the exact transformer + breakpoints path as src/components/ui/avatar.tsx.
// `src` MUST be a full public URL (coverUrl / photos[].url from the enriched reads),
// not a bare pathname — the transformer routes the blob host through /_vercel/image.
export function RecommendationImage({
  src,
  blurhash,
  alt,
  width,
  height,
  className,
}: {
  src: string
  blurhash: string | null
  alt: string
  width: number
  height: number
  className?: string
}) {
  const background = useMemo(
    () => (blurhash ? blurhashToCssGradientString(blurhash) : undefined),
    [blurhash],
  )
  return (
    <Image
      src={src}
      alt={alt}
      width={width}
      height={height}
      background={background}
      layout="constrained"
      breakpoints={snapBreakpoints(width)}
      transformer={transformer}
      className={cn('object-cover', className)}
    />
  )
}
```

- [ ] **Step 2: Write the map** (client-only; this whole module is lazy-imported, so importing `maplibre-gl` + its CSS here is safe)

Create `src/components/recommendation/RecommendationMap.tsx`:

```tsx
import 'maplibre-gl/dist/maplibre-gl.css'
import { Map, type MapRef, Marker, NavigationControl } from '@vis.gl/react-maplibre'
import { memo, useCallback, useEffect, useRef } from 'react'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { RecommendationImage } from './RecommendationImage'

type Place = RouterOutputs['recommendation']['list'][number]

// Lefkada, the boat's home water — the empty-state and fallback center (ADR-0012 §1).
const LEFKADA = { longitude: 20.65, latitude: 38.7, zoom: 9 } as const
const MAP_STYLE = `https://api.maptiler.com/maps/satellite/style.json?key=${import.meta.env.VITE_MAPTILER_API_KEY}`

// Memoized so panning/zooming (which re-renders the parent) doesn't re-render every orb.
const Orb = memo(function Orb({
  place,
  onSelect,
}: {
  place: Place
  onSelect: (id: string) => void
}) {
  return (
    <Marker longitude={place.lng} latitude={place.lat} anchor="bottom">
      <button
        type="button"
        aria-label={place.title}
        onClick={() => onSelect(place.id)}
        // ≥44px touch target; circular cover thumbnail with a ring.
        className="size-11 cursor-pointer overflow-hidden rounded-full border-2 border-background bg-muted shadow-md transition-transform hover:scale-110 focus-visible:scale-110 focus-visible:outline-2 focus-visible:outline-ring"
      >
        {place.coverUrl ? (
          <RecommendationImage
            src={place.coverUrl}
            blurhash={place.photos[0]?.blurhash ?? null}
            alt={place.title}
            width={64}
            height={64}
            className="size-full"
          />
        ) : null}
      </button>
    </Marker>
  )
})

export default function RecommendationMap({
  places,
  onSelect,
}: {
  places: Place[]
  onSelect: (id: string) => void
}) {
  const mapRef = useRef<MapRef>(null)

  // Frame all places once the map is ready and whenever the set changes. A single
  // place yields a degenerate bbox, so cap zoom; empty stays on Lefkada.
  const fitToPlaces = useCallback(() => {
    const map = mapRef.current
    if (!map || places.length === 0) return
    let minLng = Infinity
    let minLat = Infinity
    let maxLng = -Infinity
    let maxLat = -Infinity
    for (const p of places) {
      minLng = Math.min(minLng, p.lng)
      maxLng = Math.max(maxLng, p.lng)
      minLat = Math.min(minLat, p.lat)
      maxLat = Math.max(maxLat, p.lat)
    }
    map.fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      { padding: 64, maxZoom: 13, duration: 0 },
    )
  }, [places])

  // biome-ignore lint/correctness/useExhaustiveDependencies: fitToPlaces already depends on places
  useEffect(() => {
    fitToPlaces()
  }, [fitToPlaces])

  return (
    <Map
      ref={mapRef}
      initialViewState={LEFKADA}
      mapStyle={MAP_STYLE}
      onLoad={fitToPlaces}
      style={{ width: '100%', height: '100%' }}
    >
      <NavigationControl position="top-right" />
      {places.map((place) => (
        <Orb key={place.id} place={place} onSelect={onSelect} />
      ))}
    </Map>
  )
}
```

> **Verify-while-implementing (low risk):** `Map`, `mapStyle`, `initialViewState`, and the CSS import are confirmed against the current `@vis.gl/react-maplibre` docs. `Marker` (props `longitude`/`latitude`/`anchor`/children), `NavigationControl`, and `MapRef.fitBounds([[w,s],[e,n]], opts)` are the standard react-map-gl API the fork inherits — re-check the exact export names at https://visgl.github.io/react-maplibre while wiring, and adjust only if an export was renamed. `RouterOutputs` is exported from `src/lib/orpc/client.ts` (used elsewhere); confirm the import name there.

- [ ] **Step 3: Typecheck**

Run: `pnpm build`
Expected: passes (the map isn't rendered yet — it's wired into the route in Task 5; this just typechecks the components). If `RouterOutputs` isn't the exported name, adjust to the actual export in `client.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/components/recommendation/RecommendationImage.tsx src/components/recommendation/RecommendationMap.tsx
git commit -m "feat(recommendation): add image wrapper and client-only MapLibre map"
```

---

## Task 5: /recommendations route + nav entry + empty state + i18n

**Files:**
- Create: `src/routes/_authenticated/recommendations.tsx`
- Modify: `src/components/AppSidebar.tsx`, `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Consumes: `RecommendationMap` (lazy default import), `orpc.recommendation.list`, `orpc.tag.list`.
- Produces: the `/recommendations` route with `?place?: string` search state and an `onSelect` that sets `?place`; a sidebar nav item.

- [ ] **Step 1: Add the page/nav messages** to `messages/sv.json` (source of truth):

```json
"nav_recommendations": "Platser",
"meta_recommendations_title": "Platser",
"meta_recommendations_description": "Rekommenderade platser att segla till.",
"recommendations_title": "Platser",
"recommendations_description": "Upptäck platser som delägarna rekommenderar.",
"recommendations_empty_title": "Inga platser än",
"recommendations_empty_description": "När någon lägger till en plats dyker den upp här på kartan.",
"recommendation_recommended_by": "Rekommenderad av {name}",
"recommendation_photo_alt": "Foto från {title}",
"recommendation_map_loading": "Laddar karta…",
```

- [ ] **Step 2: Add the same keys to `messages/en.json`:**

```json
"nav_recommendations": "Places",
"meta_recommendations_title": "Places",
"meta_recommendations_description": "Recommended places to sail to.",
"recommendations_title": "Places",
"recommendations_description": "Discover places the owners recommend.",
"recommendations_empty_title": "No places yet",
"recommendations_empty_description": "When someone adds a place, it shows up here on the map.",
"recommendation_recommended_by": "Recommended by {name}",
"recommendation_photo_alt": "Photo from {title}",
"recommendation_map_loading": "Loading map…",
```

- [ ] **Step 3: Compile messages**

Run: `pnpm i18n:compile`
Expected: the new `m.*` functions exist (note `m.recommendation_recommended_by({ name })` and `m.recommendation_photo_alt({ title })` take a param).

- [ ] **Step 4: Add the sidebar nav item**

Edit `src/components/AppSidebar.tsx`: import `MapPinIcon` from `lucide-react` and add to `mainNavItems`:

```tsx
const mainNavItems = linkOptions([
  { to: '/', label: m.nav_calendar, icon: CalendarIcon },
  { to: '/owners', label: m.nav_owners, icon: UsersIcon },
  { to: '/recommendations', label: m.nav_recommendations, icon: MapPinIcon },
  { to: '/documents', label: m.nav_documents, icon: FolderIcon },
])
```

- [ ] **Step 5: Write the route**

Create `src/routes/_authenticated/recommendations.tsx`. `PageContainer width="full" fill` (data-screen full-bleed, ADR-0015). The map is wrapped in `<ClientOnly>` + `React.lazy` + `<Suspense>` so MapLibre never SSRs; the empty state is the shared `Empty` (CTA-less — create lands in Slice 3).

```tsx
import { useSuspenseQuery } from '@tanstack/react-query'
import { ClientOnly, createFileRoute } from '@tanstack/react-router'
import { lazy, Suspense } from 'react'
import { z } from 'zod'
import { PageContainer } from '~/components/layout/PageContainer'
import { RecommendationDetailDialog } from '~/components/recommendation/RecommendationDetailDialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { Skeleton } from '~/components/ui/skeleton'
import { useUrlDialog } from '~/hooks/useUrlDialog'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'
import { MapPinIcon } from 'lucide-react'

const RecommendationMap = lazy(() => import('~/components/recommendation/RecommendationMap'))

const recommendationsSearchSchema = z.object({
  place: z.string().optional(),
})
type RecommendationsSearch = z.infer<typeof recommendationsSearchSchema>

export const Route = createFileRoute('/_authenticated/recommendations')({
  head: () => ({
    meta: seo({
      title: m.meta_recommendations_title(),
      description: m.meta_recommendations_description(),
    }),
  }),
  validateSearch: recommendationsSearchSchema,
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData(orpc.recommendation.list.queryOptions()),
      queryClient.ensureQueryData(orpc.tag.list.queryOptions()),
    ])
  },
  component: Recommendations,
})

function Recommendations() {
  const navigate = Route.useNavigate()
  const place = Route.useSearch({ select: (s) => s.place })
  // Reuse the URL-dialog hook with a single 'place' key: open writes ?place=<id>.
  const { open, close } = useUrlDialog<'place', RecommendationsSearch>({
    current: place ? 'place' : undefined,
    navigate,
    clearKeys: [],
  })

  const { data: places } = useSuspenseQuery(orpc.recommendation.list.queryOptions())

  if (places.length === 0) {
    return (
      <PageContainer width="default">
        <Header />
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MapPinIcon className="size-8" />
            </EmptyMedia>
            <EmptyTitle>{m.recommendations_empty_title()}</EmptyTitle>
            <EmptyDescription>{m.recommendations_empty_description()}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageContainer>
    )
  }

  return (
    <PageContainer width="full" fill>
      <Header />
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border">
        <ClientOnly fallback={<Skeleton className="size-full" />}>
          <Suspense fallback={<Skeleton className="size-full" />}>
            <RecommendationMap
              places={places}
              onSelect={(id) => navigate({ to: '.', search: { place: id } })}
            />
          </Suspense>
        </ClientOnly>
      </div>

      <RecommendationDetailDialog
        placeId={place}
        open={place !== undefined}
        onOpenChange={(next) => {
          if (!next) close()
        }}
      />
    </PageContainer>
  )
}

function Header() {
  return (
    <header className="flex flex-col gap-2">
      <h1 className="font-bold text-2xl tracking-tight text-balance md:text-3xl">
        {m.recommendations_title()}
      </h1>
      <p className="max-w-2xl text-muted-foreground text-sm">{m.recommendations_description()}</p>
    </header>
  )
}
```

> `useUrlDialog`'s generics are `<DialogName, Search>`; here the single dialog is `'place'`. If the hook's `open`/`close` signature differs from this usage (confirm against `src/hooks/useUrlDialog.ts` and the `owners.tsx` consumer), fall back to plain `navigate({ to: '.', search: { place: id } })` to open and `navigate({ to: '.', search: {} })` to close — the URL is the single source of truth either way.

- [ ] **Step 6: Compile route tree + verify it builds**

Run: `pnpm build`
Expected: `routeTree.gen.ts` regenerates with the new route; build passes. (`RecommendationDetailDialog` is created in Task 6 — to keep Task 5 independently buildable, either implement Task 6 immediately after, or temporarily stub `RecommendationDetailDialog` to `return null`. Prefer doing 5→6 back-to-back.)

- [ ] **Step 7: Live-verify the map + nav** (needs `VITE_MAPTILER_API_KEY` in `.env`)

Run: `pnpm dev`, sign in, click the **Platser** sidebar item. With seeded/created places, expect: a satellite map framed to the places, circular cover orbs, a working zoom control, and no SSR/hydration error in the console. With an empty DB, expect the Lefkada-centered empty state (icon + title + description, no CTA). Verify on a narrow viewport too (map fills height, orbs tappable).

- [ ] **Step 8: Commit**

```bash
git add src/routes/_authenticated/recommendations.tsx src/routeTree.gen.ts src/components/AppSidebar.tsx messages/sv.json messages/en.json src/paraglide
git commit -m "feat(recommendation): add /recommendations map route and nav entry"
```

---

## Task 6: RecommendationDetailDialog — carousel + metadata + tag chips

**Files:**
- Create: `src/components/recommendation/RecommendationDetailDialog.tsx`

**Interfaces:**
- Consumes: `orpc.recommendation.get` (full photos with `url`), `orpc.tag.list` (id → slug), `RecommendationImage`, `TagChip`, `isTagSlug`, the shadcn `Carousel`, `ResponsiveDialog`.
- Produces: `<RecommendationDetailDialog placeId={string | undefined} open={boolean} onOpenChange={(open: boolean) => void} />`.

- [ ] **Step 1: Write the dialog**

The dialog reads the full place via `get` (all photos carry `url`; the loader has it cached on deep-link, and a fresh click fetches it quickly). Tag `id`s resolve to slugs via the cached `tag.list`; unknown slugs are skipped (defensive). A single-photo place just shows the photo without arrows.

Create `src/components/recommendation/RecommendationDetailDialog.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from '~/components/ui/carousel'
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '~/components/ui/responsive-dialog'
import { Skeleton } from '~/components/ui/skeleton'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { isTagSlug } from './tagLabels'
import { RecommendationImage } from './RecommendationImage'
import { TagChip } from './TagChip'

export function RecommendationDetailDialog({
  placeId,
  open,
  onOpenChange,
}: {
  placeId: string | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { data: place, isLoading } = useQuery({
    ...orpc.recommendation.get.queryOptions({ input: { id: placeId ?? '' } }),
    enabled: open && placeId !== undefined,
  })
  const { data: tags } = useQuery(orpc.tag.list.queryOptions())

  const slugById = new Map((tags ?? []).map((t) => [t.id, t.slug]))
  const placeSlugs =
    place?.tagIds.map((id) => slugById.get(id)).filter((s): s is string => s !== undefined) ?? []

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-2xl">
        {isLoading || !place ? (
          <div className="flex flex-col gap-4">
            <Skeleton className="aspect-video w-full rounded-lg" />
            <Skeleton className="h-6 w-2/3" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <Carousel className="w-full" opts={{ loop: place.photos.length > 1 }}>
              <CarouselContent>
                {place.photos.map((photo) => (
                  <CarouselItem key={photo.id}>
                    <div className="aspect-video w-full overflow-hidden rounded-lg bg-muted">
                      <RecommendationImage
                        src={photo.url}
                        blurhash={photo.blurhash}
                        alt={m.recommendation_photo_alt({ title: place.title })}
                        width={800}
                        height={450}
                        className="size-full"
                      />
                    </div>
                  </CarouselItem>
                ))}
              </CarouselContent>
              {place.photos.length > 1 ? (
                <>
                  <CarouselPrevious />
                  <CarouselNext />
                </>
              ) : null}
            </Carousel>

            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle>{place.title}</ResponsiveDialogTitle>
              {place.authorName ? (
                <ResponsiveDialogDescription>
                  {m.recommendation_recommended_by({ name: place.authorName })}
                </ResponsiveDialogDescription>
              ) : null}
            </ResponsiveDialogHeader>

            {place.description ? (
              <p className="text-sm whitespace-pre-wrap">{place.description}</p>
            ) : null}

            {placeSlugs.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {placeSlugs.filter(isTagSlug).map((slug) => (
                  <TagChip key={slug} slug={slug} />
                ))}
              </div>
            ) : null}
          </div>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
```

> Confirm the `ResponsiveDialog*` export names and that `ResponsiveDialogContent` accepts `className` (against `src/components/ui/responsive-dialog.tsx`). The shadcn `Carousel` width is set on the wrapper at ~`gallery` size (800px snaps via the transformer's breakpoints); the full-tap-to-2048 enhancement is optional polish, not required for this slice.

- [ ] **Step 2: Typecheck + build**

Run: `pnpm build`
Expected: passes; the route from Task 5 now resolves `RecommendationDetailDialog`.

- [ ] **Step 3: Live-verify the detail flow**

Run: `pnpm dev`. On `/recommendations`, click an orb → the dialog opens with `?place=<id>` in the URL, shows the photo carousel (arrows only with >1 photo), title, "Rekommenderad av …", description, and tag chips. Close it → `?place` clears. Reload a `…/recommendations?place=<valid-id>` URL → dialog opens from the deep link (loader-cached). Hit a bogus `?place=<random-uuid>` → the dialog shows the loading skeleton then resolves empty (NOT_FOUND from `get`); confirm no uncaught error (acceptable: it stays on the skeleton — Slice 2 needn't toast). Verify mobile: the dialog becomes a bottom sheet (`ResponsiveDialog`), carousel swipes.

- [ ] **Step 4: Commit**

```bash
git add src/components/recommendation/RecommendationDetailDialog.tsx
git commit -m "feat(recommendation): add detail dialog with photo carousel and tag chips"
```

---

## Task 7: Wrap-up, review, live verification

**Files:** none new — verification + review only.

- [ ] **Step 1: Compile + lint + build + node tests**

```bash
pnpm i18n:compile && pnpm check:ci && pnpm build && pnpm test:node
```
Expected: all clean (`test:node` includes the new `tagLabels.test.ts`).

- [ ] **Step 2: Review checkpoints**

- Run `vercel:react-best-practices` over the new TSX (map memoization, `ClientOnly`/`lazy`, no `useState` for derived values).
- Run the `code-reviewer` agent on the diff (ADR adherence: read-only scope, effects-in-procedure-not-service, i18n completeness, responsive).
- `test-completeness`: confirm the only new testable unit (`tagLabels`) is covered; the UI is verified live (documented limitation — no `RouterProvider` in the browser harness yet).

- [ ] **Step 3: Full live walkthrough** (record a short GIF if helpful)

With `VITE_MAPTILER_API_KEY` set and ≥2 seeded places spread apart:
1. **Nav** — "Platser" appears in the sidebar between Owners and Documents; routes to `/recommendations`.
2. **Map** — satellite tiles, framed to all places, circular cover orbs, zoom control, no console/hydration errors.
3. **Detail** — orb click opens the dialog (`?place=`), carousel + title + author + description + tag chips; close clears the param; deep link works.
4. **Empty** — with no places, the Lefkada-centered empty state (no CTA).
5. **Responsive** — narrow viewport: full-height map, tappable orbs, dialog as bottom sheet.
6. **Realtime (optional)** — creating a place elsewhere (e.g. via a second session once Slice 3 lands) invalidates and re-renders without reload.

- [ ] **Step 4: Open the slice PR**

Squash-merge repo: PR **title** = a conventional-commit subject (e.g. `feat(recommendation): add read-only map and detail view (ADR-0012 slice 2)`); PR **body** = the *why* + a link to ADR-0012 and this plan + the live-verification checklist above. One concern per PR.

---

## Done-when (Slice 2 acceptance)

- [ ] `/recommendations` renders a client-only MapLibre **satellite** map, auto-framed to all active places, with circular cover-photo orbs and a touch-sized zoom control; no SSR/hydration errors.
- [ ] Tapping an orb (or deep-linking `?place=<id>`) opens a responsive detail dialog with a photo **carousel**, title, author, description, and **tag chips**; closing clears `?place`.
- [ ] Empty DB shows the shared Lefkada-centered **empty state** (no CTA).
- [ ] A **"Platser"** sidebar nav entry routes to `/recommendations`.
- [ ] `tagLabels` covers every seeded slug (test green); all new strings localized in `sv` + `en`.
- [ ] `list`/`get` reads carry public photo URLs (`coverUrl` / `photos[].url`); no service touches effects.
- [ ] Only `maplibre-gl`, `@vis.gl/react-maplibre`, `embla-carousel-react` added; `VITE_MAPTILER_API_KEY` documented in `.env.example`.
- [ ] `pnpm check:ci && pnpm build && pnpm test:node` all green; responsive on mobile/tablet/desktop.

---

## Self-review notes (author)

**Spec coverage (ADR-0012 Slice 2 row = "RecommendationMap (client-only, fit-to-places, orbs), RecommendationDetailDialog (carousel, no social yet), nav entry, /recommendations route"):** Map → Task 4/5; detail dialog + carousel → Task 6; nav → Task 5; route → Task 5. Tag chips (detail-only, per the decided scope) → Tasks 2 + 6. All four ADR items covered; no like/comment surfaces (correctly deferred).

**Deliberate deviations / decisions, flagged for the reviewer:**
- **Read-URL enrichment (Task 3)** is the one backbone change. It's necessary because the avatar path renders from a *stored* URL while recommendation photos store only a pathname; putting it in the procedure (not the service) respects ADR-0001. `list` enriches only the cover to bound prod `head` calls; `get` enriches all. Revisit trigger: denormalize a `url` column if list latency matters.
- **SSR strategy** uses `ClientOnly` + `React.lazy` rather than `vite.config.ts` `ssr.external` (ADR-0012 §1 lists lazy-import as the sanctioned alternative; the config has no `ssr.external` block).
- **Verification is live-browser-led**, not TDD, for the map/dialog — the browser-mode harness lacks `RouterProvider` and MapLibre needs WebGL (`test/browser/README.md`). The one cheap, valuable unit test (tag-label exhaustiveness, DB-backed) is included.

**Type consistency:** `coverUrl` (list) and `photos[].url` (get) are the only payload additions; the map reads `place.coverUrl` + `place.photos[0].blurhash`, the dialog reads `photo.url` + `photo.blurhash`. `RecommendationMap` is a **default export** (required by `React.lazy`). `RouterOutputs['recommendation']['list'][number]` is the single source for the `Place` type.

**Library-API caveats to verify while implementing (low risk, all noted inline):** `@vis.gl/react-maplibre` exports `Marker`/`NavigationControl`/`MapRef` (standard react-map-gl surface — `Map`/`mapStyle`/`initialViewState`/CSS already confirmed); shadcn `Carousel` export names; `ResponsiveDialog*` export names and `className` passthrough; `useUrlDialog` `open`/`close` signature (plain `navigate` is the documented fallback).
