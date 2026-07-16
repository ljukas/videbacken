# ADR 0012 — Recommended Sailing Places

- **Status**: Proposed
- **Date**: 2026-06-27 (supersedes the 2026-06-14 lean draft — see "Scope: what changed" below)
- **Deciders**: Lukas
- **Decision in one line**: A map + list feature where owners pin photo "orbs" of places they've sailed to — render with **MapLibre GL JS** (open engine) over **MapTiler** tiles (the tile provider is a swappable adapter behind the engine, like R2 in ADR-0006); each place carries **several photos** as `file` rows through a `recommendation_photo` join (a cover-led, reorderable gallery — the avatar *byte-path* reused, but one-to-many), served at three sizes on demand from the `unpic` transformer with **no thumbnail worker**; **guess the location from the first GPS-bearing photo's EXIF client-side** (`exifr`, editable, manual fallback); model location as two `double precision` columns with **client-side Haversine** distance (no PostGIS); tag places from a **fixed, curated, seeded `tag` set** (no user-created tags); ship **likes and comments in the first feature** (not deferred); and present the places as both a **map** (default-centered on Lefkada, auto-fit to all places) and a **sortable list** (newest / most-loved / nearest-me).

---

## Scope: what changed from the 2026-06-14 draft

The original draft deliberately shipped a *lean* first slice — one photo, tags, EXIF — and deferred likes, comments, and multi-photo to "future phases." This revision **inverts that**: the first feature is the *complete* experience. The engine-level choices (MapLibre, MapTiler, the avatar byte-path, Haversine, code-only errors) were sound and are kept verbatim. Four things changed:

| Area | 2026-06-14 draft | This revision | Why |
|---|---|---|---|
| **Photos** | exactly one (`fileId` FK, avatar pattern) | **many** (≤~10) via `recommendation_photo` join; cover-led, reorderable gallery | a cove deserves several angles; UX polish is worth the join |
| **Tags** | system **+** custom (dedup on `lower(label)`, dual rendering) | **fixed curated, seeded set** only | custom-tag machinery was the heaviest part of the doc; a curated set is simpler *and* a more consistent vocabulary at this scale |
| **Likes & comments** | designed, **not built** | **built in the first feature** | the value is a *living* shared map, not a static one |
| **Views** | map only | **map + sortable list** (toggle) | likes ("most-loved") and Haversine ("nearest me") need a surface to render a sort; a pure map has none |
| **Map bounds** | hard `maxBounds` to the Ionian | **default-center Lefkada + auto-fit to places**, no hard bounds | the boat barely leaves home (places self-cluster), so a cage only blocks the occasional legitimate out-of-region pin |

This is a large feature for "one concern per PR." The ADR records the whole design; the **build is sliced** into independently shippable, testable PRs — see [Build sequence](#build-sequence-one-pr-per-slice).

---

## Context

ADR-0006 wired the byte-path (storage adapters, public/private stores, the three-step mint→PUT→confirm upload flow, the `file` metadata table). ADR-0010 layered document *management* on top of `file`. This ADR adds a different consumer of the same primitives: a **place-recommendation map**.

The boat lives in the Ionian, around Lefkada. Owners accumulate local knowledge — a quiet anchorage on the east coast, a taverna in Vasiliki, a cove worth the detour — and today that knowledge lives in their heads and group chats. The shape of the need:

- A **map** centered on Lefkada showing every recommended place as a photo **orb** (its cover photo).
- A **list** view of the same places, sortable by newest, most-loved, or nearest to me — the social/proximity ranking the map can't express.
- Tapping an orb (or a list row) opens a **detail view** — a photo gallery, the author's note on *why* it's recommended, likes, and a comment thread.
- Creating a recommendation means uploading **one or more** photos. Phone photos carry **EXIF GPS**, so we **guess the location** from the first photo that has it and drop the marker there; the author nudges it if the guess is off (or places it by hand when no photo has GPS).
- **Likes** so good spots float to the top, and **comments** for discussion — both in the first feature.

### Why this is a new ADR (the deletion test)

Delete the recommendation module and ask what survives. The storage byte-path, the avatar flow, the document library, realtime, the queue — all untouched. What reappears, and only here, is: the map, orbs, places, EXIF-derived locations, the photo gallery, tags, likes, and comments. Complexity *concentrates* in this module rather than leaking back into the seams it sits on. That is the signal that it earns its own ADR rather than an amendment to ADR-0006.

### Seams it consumes — none of them change

This feature is a **consumer**, not a modification, of five existing seams:

- **Storage** (ADR-0006) — `storage.mintUploadToken` / `head` / `delete` / `getReadUrl`, public store, env-prefixed pathnames. `runUploadFlow` (`src/lib/effects/storage/clientUpload.ts`) reused per photo. Untouched.
- **Realtime** (ADR-0004) — `realtime.publish(...)` + the single `useRealtimeSync()` dispatcher. We add **one** event kind (`recommendation.changed`); the bus is unchanged.
- **Queue** (ADR-0007) — the `blurhash` topic (`src/lib/queue/handlers/blurhash.ts`). We add a `'recommendation'` kind to the existing handler; no new topic.
- **Service / domain-error** (ADR-0002, 2026-06-13 amendment) — services own DB access; procedures surface `<Entity>DomainError` as **code-only typed oRPC errors** (status only, no backend i18n) and the client localizes by code. We follow the newer `document`/`folder` router pattern, not the older `rethrowAsORPC`-to-Swedish one.
- **Forms** (ADR-0005) — `useAppForm` + bound fields.

### The one genuinely new seam: map rendering

The only new architectural seam this ADR introduces is **map rendering**. MapLibre GL JS is the deep module — pan, zoom, vector-tile rendering, markers, styles, all behind a small `<Map>` / `<Marker>` interface — and the **tile provider is the adapter** at that seam.

This is a **one-adapter seam that stays reversible**, not a proven multi-adapter seam — and the ADR is honest about the difference (the skill's rule: *one adapter = not yet a proven seam, two = real seam*). We don't claim hidden depth from a single provider; the leverage we *do* have is that MapLibre's interface is a standard style URL, so swapping MapTiler for Stadia, OpenFreeMap, or a self-hosted Protomaps extract is a config change, not a rewrite. This is exactly the posture ADR-0006 takes toward R2 — design and document the swap, don't build it twice.

### Where we deliberately refuse shallow modules

Each of these passes the deletion test the *other* way — delete the would-be module and no complexity reconcentrates, because an existing seam already covers the need. So the module would be shallow, and we don't build it.

- **No `document`-style wrapper for the photos.** ADR-0010 added `document` over `file` because documents carry real management concerns (folders, search, bin, history, rename-with-storage-copy). A recommendation's photos have none of those. Delete a hypothetical wrapper and callers simply read the `file` rows directly, exactly as avatars do — no complexity reappears. Shallow; don't build it. (Multi-photo does **not** change this: it's a `recommendation_photo` join straight to `file`, not a `document`.)
- **No `image_thumbnail` worker.** That worker exists in ADR-0010 *only* because documents live in the private store behind signed per-read URLs that Vercel Image Optimization can't address (ADR-0010 Alternative L). Recommendation photos live in the **public** store; delete a hypothetical worker and the `unpic` transformer already serves on-demand sizes — a worker would only duplicate it. Shallow; don't build it.
- **No PostGIS.** Sorting a few dozen already-loaded points by distance does not justify a spatial extension. Delete a hypothetical PostGIS column and the pure `haversineKm` helper already covers the need with full locality. Shallow; don't add it.
- **No custom/user-created tags.** A fixed curated set covers the vocabulary at this scale; delete the custom-tag machinery (dedup on `lower(label)`, the system/custom rendering split) and nothing of value is lost — a seeded lookup table already serves filtering and localization. Shallow at 20 users; documented as a future phase if owners ever ask.

### Where the real depth is

With custom tags gone, the `tag` module is now a **simple seeded reference** (a lookup table + a `slug → m.tag_<slug>()` registry), not a deep module. The depth in this feature now lives in three places:

1. **The map seam** — MapLibre (deep engine) + the swappable tile-provider adapter; cheap to swap by construction.
2. **Multi-photo + EXIF orchestration** — the create/edit flow runs the avatar three-step *per file*, lets the author add/remove/reorder photos and choose a cover, and derives the location from the first GPS-bearing photo before the HEIC transcode strips it. The complexity is real and concentrated in the editor + service transaction.
3. **Social aggregation** — `listRecommendations` folds `likeCount` + `likedByMe` (and photo cover + tag set) into one payload so the map/list render without N+1 round-trips.

---

## Decision (TL;DR)

A place-recommendation **map + list** with the following load-bearing pieces:

1. **Map engine = MapLibre GL JS** via `@vis.gl/react-maplibre`. The map components are **client-only** — MapLibre needs `window` / WebGL and does not server-render. The idiom: gate rendering on a `mounted` flag (`const [mounted, setMounted] = useState(false); useEffect(() => setMounted(true), [])`) and return a **same-shape placeholder** on the server pass (`<div className="size-full …" />`), never `return null` (that's a hydration mismatch). `maplibre-gl` + `@vis.gl/react-maplibre` are browser-only, so add them to `ssr.external` in `vite.config.ts` (or lazy-import the map component) so they stay out of the SSR bundle; the CSS (`maplibre-gl/dist/maplibre-gl.css`) is imported once. Default style = **satellite** (coastal use); initial view centered on Lefkada (~`{ longitude: 20.65, latitude: 38.70 }`); **once places load, `fitBounds` to their bounding box** (with padding) so the map frames exactly the recommendations; empty state stays on Lefkada. **No `maxBounds`** — pannable/pinnable anywhere; places self-cluster near home. A touch-sized `NavigationControl`.

2. **Tiles = MapTiler**, behind the open engine. Style URL `https://api.maptiler.com/maps/<style>/style.json?key=${import.meta.env.VITE_MAPTILER_API_KEY}` — the key is **client-exposed by nature** (the browser fetches the style), so it is *not* a secret; it is restricted by HTTP-referrer in the MapTiler dashboard. The provider is a swappable adapter (Stadia / OpenFreeMap / self-hosted Protomaps PMTiles are documented swap-ins).

3. **Photos = avatar byte-path, one-to-many.** A `recommendation` row has **many** `recommendation_photo` rows, each carrying a `fileId` FK to a `file` row in the **public** store (`recommendations/{userId}/{uuid}.{ext}`) plus a `sortOrder`. The **cover** is the lowest `sortOrder` (shown as the orb); photos are **reorderable** (drag) and the detail view is a **carousel**. Cap ~10 photos (service-enforced; ≥1 required). Blurhash reuses the `blurhash` queue topic (a `'recommendation'` kind that only sets `file.blurhash` — no denormalization, like the `'document'` kind). **Three render sizes from each stored original**, via the `unpic` transformer's `width` param:
   - **orb** ~64px (reuses the avatar `<Avatar>` / transformer `<img>`),
   - **gallery thumbnail** ~400px (200 @2×),
   - **full** a bounded ~2048px transform.
   No separate thumbnail asset, no `thumbnailPathname`, no `image_thumbnail` worker.

4. **EXIF location, guessed client-side from the first GPS-bearing photo.** Before upload (and before the existing HEIC→JPEG transcode, which can strip metadata), the client reads GPS from each chosen file with `exifr.gps(file)` and pre-fills the location marker from the **first photo that has coordinates**. When no photo has GPS (screenshots, re-saved/socially-shared images, location-off), the picker opens on Lefkada with no marker and the author places it by hand. The location is always editable.

5. **Location = two `double precision` columns** (`lat`, `lng`) with CHECK bounds, **one per place** (not per photo). Distance ("sort by closest to me") is computed **client-side with a `haversineKm` helper** over the places already loaded; "current location" comes from the browser Geolocation API, which the server never sees and never stores. On geolocation deny/error the sort **silently stays unsorted** (log, no toast). No PostGIS, no spatial index, no server-side distance.

6. **Tags = fixed, curated, seeded `tag` set + `recommendation_tag` join**, multi-tag. ~10–12 **system** tags are seeded by a data-only migration and localized via a `slug → m.tag_<slug>()` registry; **there are no user-created tags**. The map and list filter places by tag, client-side. Adding a tag = seed migration + `m.tag_<slug>()` message + registry entry.

7. **Likes & comments — built in the first feature.** `recommendation_like` (composite PK, toggle) drives a heart + count, premiers orbs visually, and powers the "most-loved" list sort. `recommendation_comment` (soft-delete, author-or-admin delete) is a thread in the detail view. Both mutations publish `recommendation.changed`.

8. **Views = map + sortable list (toggle).** The list shows the same places with cover photo, title, tags, and like count, sortable by **newest / most-loved / nearest-me**. One `/recommendations` route hosts both; the detail is a responsive dialog with URL state (ADR-0013); the create/edit **editor is a dedicated route** (ADR-0013 names it explicitly — a complex, growing, multi-photo form belongs on its own page, not in an overlay).

9. **Realtime.** Add a single `recommendation.changed` to the existing event union; the one `useRealtimeSync()` dispatcher invalidates `orpc.recommendation.key()`. Create / edit / delete / reorder / like / comment all publish it. (No `tag.changed` — tags are seeded and immutable at runtime.)

10. **Access model** (echoing ADR-0010's amendment): reads (map, list, detail) are gated on **authentication only** — these are the shared recommendations of one boat's owners. **Create** is any authenticated owner; **edit / delete / reorder** a recommendation is **author-or-admin**; **like** is any authenticated owner (toggles their own); **comment create** is any authenticated owner; **comment delete** is **author-or-admin**. All author-or-admin checks live in the service (admin bypass inside the service). Per-recommendation privacy is deliberately out of scope.

---

## Alternatives considered

### Map engine

#### A. Leaflet (rejected)
- ➕ Simplest possible API; huge ecosystem; no API key needed with OSM raster tiles.
- ➖ Stale: 1.9.x dates from 2023, 2.0 is still alpha. Raster-first; vector/WebGL is a bolt-on. Raster tiles are heavier and blurrier on zoom than vector.
- **Verdict**: rejected — we don't want to start a 2026 feature on a 2023 raster-first engine.

#### B. Mapbox GL JS (rejected)
- ➕ Best-in-class styles and satellite imagery; mature React wrappers.
- ➖ GL JS v2+ is **proprietary** and couples the engine to Mapbox's tiles + access token. The "tile provider is a swappable adapter" property — the whole point of our seam — is lost; switching providers would mean rewriting the map component, not changing a URL.
- **Verdict**: rejected — the lock-in defeats the seam. Cost was never the deciding factor (every free tier dwarfs ~20 users).

#### C. MapLibre GL JS (chosen)
- ➕ Open-source WebGL vector engine (the community fork of Mapbox GL v1); TypeScript-native; consumes a standard style URL. Keeps the provider seam **cheap and real-on-demand** — MapTiler today, Stadia/OpenFreeMap/Protomaps tomorrow, no component rewrite.
- ➖ Needs `window`/WebGL → client-only (no SSR). Adds a client dependency.
- **Verdict**: chosen — the open engine is what makes the provider a swappable adapter.

### Tile provider

All free tiers exceed ~20 users by ~100×, so cost is not the differentiator — lock-in, imagery, and key management are.

- **MapTiler (chosen)** — open MapLibre engine + hosted tiles (satellite/outdoor/streets), ~100k tiles/mo free, one `VITE_MAPTILER_API_KEY`. Provider swappable because the engine is open. Satellite imagery is genuinely useful for reading a coastline.
- **Stadia Maps (runner-up)** — open engine; perpetual free, no credit card, explicitly licensed for non-commercial/low-volume — the cleanest license fit. Kept as the first swap-in.
- **OpenFreeMap (documented swap-in)** — no key, no signup, no limits, but an external community service with no SLA.
- **Protomaps PMTiles, self-hosted (documented swap-in)** — cut a small Ionian extract with the `pmtiles` CLI (a few MB), host it in the existing public Blob store, serve via HTTP range requests. Fully self-contained, free forever, zero external dependency — the same "own-it" posture R2 represents for storage.

### Photo cardinality

#### A. Single photo, `fileId` FK / avatar pattern (rejected for v1)
- ➕ Simplest: one join, the exact avatar shape, no ordering or cover concept.
- ➖ A place is rarely one frame — the cove, the taverna, the view from the anchorage. One photo undersells the recommendation.
- **Verdict**: rejected — chosen scope wants a gallery. (This was the 2026-06-14 decision; superseded.)

#### B. Inline image columns on the recommendation row (rejected)
- ➖ Duplicates the `file` lifecycle the byte-layer already owns (blurhash, soft-delete, storage cleanup, `owner_id`/`pathname`/`mime`/`size`), and can't express *many* photos without an array of denormalized blobs.
- **Verdict**: rejected — re-solves a solved problem.

#### C. `recommendation_photo` join → `file` rows, cover-led + reorderable (chosen)
- ➕ Reuses the entire byte-layer per photo (upload flow, storage seam, blurhash, public-store serving); ≤~10 photos, cover = lowest `sortOrder`, drag-reorder, carousel detail.
- ➕ Still **not** a `document` wrapper — a thin join straight to `file`, so the "no document wrapper" deletion test still holds.
- ➖ A join table, a per-file upload loop, and a small reorder UI. One extra query on read (folded into the list payload).
- **Verdict**: chosen.

### Image sizing

#### A. `image_thumbnail` background worker, à la ADR-0010 (rejected)
- ➖ That worker exists **solely** to work around the private store's signed URLs, which VIO can't optimize. Public-store photos have no such constraint. Cargo-culting machinery.
- **Verdict**: rejected — wrong problem.

#### B. One stored original per photo + on-demand transformer sizing, à la avatars (chosen)
- ➕ Three (or any) sizes from each original via the `unpic` transformer's `width` param. No worker, no extra asset, no `thumbnailPathname`. The "full" tier is a bounded-large transform (~2048px) — near-indistinguishable on screen, far lighter than raw bytes, CDN-cached by VIO.
- ➖ Dev caveat: the transformer passes through in dev (`import.meta.env.DEV`), so dev fetches full bytes per size. Acceptable at this scale — identical to avatars today.
- **Verdict**: chosen.

### Location / distance

#### A. PostGIS `geography(Point,4326)` (rejected for v1)
- ➕ Correct great-circle distance; `ST_Distance`/`ST_DWithin`; GiST KNN `<->`.
- ➖ Over-powered for sorting a few dozen points already held in memory client-side. Heavy extension + a Drizzle custom column type for power we wouldn't use.
- **Verdict**: rejected for v1; documented as the swap-in (trigger below).

#### B. `earthdistance` + `cube` (rejected)
- ➖ Clunky cube API; still server-side work this access pattern doesn't need.
- **Verdict**: rejected.

#### C. Native `point` type (rejected)
- ➖ **Planar** — its distance is in degrees, and a degree of longitude at 38.7°N is ~22% shorter than a degree of latitude, so distances would be wrong.
- **Verdict**: rejected — silently incorrect.

#### D. Two `double precision` columns + client-side Haversine (chosen)
- ➕ Accurate (Haversine), zero extension, zero index. The list already loads all places and "current location" is a browser concern, so distance is naturally a client computation. Echoes ADR-0010's deliberate seq-scan-at-this-scale precedent.
- ➖ No server-side radius filtering (we don't need it; trigger documented).
- **Verdict**: chosen.

### Tags

#### A. Single-category FK (rejected)
- ➖ A place is often several things at once (a cove that's also a good anchorage with a taverna). One category can't express that.
- **Verdict**: rejected.

#### B. `text[]` array column (rejected)
- ➕ Simplest schema; GIN-indexable.
- ➖ No referential integrity or shared display order; weak localization of the baseline tags (you'd validate against a constant either way).
- **Verdict**: rejected — a seeded table is barely more work and gives FK integrity + an ordering home.

#### C. Shared normalized `tag` with **system + custom** (rejected this revision)
- ➕ Lets owners coin their own vocabulary; deduped + shared.
- ➖ The dedup on `lower(label)`, the system/custom rendering split, and the `createCustomTag` op / `INVALID_LABEL` error / `tag.changed` event are the **heaviest mechanism in the whole feature** — and at 20 users they buy little over a curated set, while risking "snorkling" vs "snorkeling" drift.
- **Verdict**: rejected — disproportionate machinery; revisit as a future phase if asked. (This was the 2026-06-14 choice; superseded.)

#### D. Fixed, curated, seeded `tag` set + join (chosen)
- ➕ Multi-tag; ~10–12 localized tags; consistent governed vocabulary; clean `slug → m.tag_<slug>()` localization; trivial filter-by-tag. No dedup, no dual rendering, no tag write-path, no tag error codes, no `tag.changed`.
- ➖ Adding a tag needs a (tiny) migration + message + registry entry — fine for an admin-curated vocabulary.
- **Verdict**: chosen.

### EXIF extraction

#### A. Server-side `sharp` in a worker (rejected)
- ➖ Bytes never transit a Function (ADR-0006); the server doesn't see the image. We'd need a fetch-back worker to read metadata the client already holds at upload time.
- **Verdict**: rejected — fights the out-of-process byte path.

#### B. Client-side EXIF read before upload, first GPS-bearing photo wins (chosen)
- ➕ Reads GPS from each original file in the browser, before the HEIC transcode that would strip it; pre-fills from the first photo with coordinates. Sends `{ lat, lng }` in the create payload. Fits the byte path exactly.
- ➖ Not every photo has GPS — mitigated by manual placement and "always editable."
- **Verdict**: chosen.

> **2026-06-29 amendment — `exifr` → `exifreader`.** The library was originally `exifr`, whose docs advertise HEIC support. In practice exifr's HEIC detector rejects any file whose `ftyp` box exceeds 50 bytes (`getUint16(2) > 50`), throwing "Unknown file format". Every modern iPhone HEIC has a larger `ftyp` box (major brand `heic` + several compatible brands, e.g. `mif1 MiHB MiHA heix` → 52 bytes), so GPS was silently never read for the dominant photo source and `readGpsFromFile` always fell back to manual placement. exifr 7.1.3 is the latest release, so no version bump fixes it. Switched to `exifreader` (used identically in `src/lib/files/exif.ts`, the lone EXIF consumer), which parses iPhone HEIC correctly; `{ expanded: true }` returns `gps.Latitude`/`gps.Longitude` as sign-applied decimals. Also fixed a latent companion bug: `LocationPicker` only honored `value` at mount via `initialViewState`, so a programmatically-set location outside the default Lefkada view dropped the pin off-screen — it now `flyTo`s the point when it isn't already visible (guarded so manual click/drag never jars the camera).

### Likes & comments — build now vs. design for later

- **Design for later (rejected this revision)** — keeps the first slice tiny, but ships a *static* map; the living, social part (which spots are loved, "is this taverna still good?") is the actual point of a shared boat map.
- **Build now (chosen)** — they're additive (new tables, thin procedures, reusing the single `recommendation.changed` event) and slice cleanly into their own PRs, so building them now widens the feature without entangling the core. (This was deferred on 2026-06-14; now in scope.)

---

## Architecture

### Schemas (`src/lib/db/schema/recommendation.ts`)

Follows house conventions: uuid PK, `timestamptz`, `$onUpdate`, soft-delete, CHECK for physical truths (ADR-0006/0010; the 2026-05-26 timestamptz + CHECK decisions).

```ts
// recommendation — the place + the "why"; one location, many photos
recommendation
  id          uuid pk defaultRandom
  author_id   uuid → user.id   on delete set null   -- preserve content if an owner is removed
  title       text not null
  description text                                   -- nullable: the "why"
  lat         double precision not null              -- coordinates as double; distance is JS Haversine
  lng         double precision not null
  created_at  timestamptz default now() not null
  updated_at  timestamptz default now() $onUpdate not null
  deleted_at  timestamptz                            -- soft-delete (author/admin)
  CHECK lat BETWEEN -90 AND 90
  CHECK lng BETWEEN -180 AND 180
  index (author_id); index (deleted_at) where deleted_at is null
```

```ts
// recommendation_photo — many photos per place; cover = lowest sort_order
recommendation_photo
  id                uuid pk defaultRandom
  recommendation_id uuid → recommendation.id on delete cascade
  file_id           uuid unique → file.id on delete restrict   -- 1:1 photo↔file; byte lifecycle flows through the service
  sort_order        int not null   CHECK sort_order >= 0       -- cover = MIN(sort_order); reorderable
  created_at        timestamptz default now() not null
  index (recommendation_id)   -- forward lookup (photos of a place); cap ~10 enforced in service
```

```ts
// tag — fixed, curated, seeded; NO custom tags, NO label/created_by/dedup
tag
  id         uuid pk defaultRandom
  slug       text unique not null   -- e.g. 'restaurant'; UI → m.tag_<slug>()
  sort_order int not null           -- display order in picker/filters
  created_at timestamptz default now() not null

// recommendation_tag — many-to-many join
recommendation_tag
  recommendation_id uuid → recommendation.id on delete cascade
  tag_id            uuid → tag.id            on delete restrict
  primary key (recommendation_id, tag_id)   -- PK leads with recommendation_id (forward lookup free)
  index (tag_id)   -- reverse lookup (filter places by tag)

// recommendation_like — one toggleable like per user; premier by count
recommendation_like
  recommendation_id uuid → recommendation.id on delete cascade
  user_id           uuid → user.id            on delete cascade
  created_at        timestamptz default now() not null
  primary key (recommendation_id, user_id)

// recommendation_comment — thread in the detail view; soft-delete
recommendation_comment
  id                uuid pk defaultRandom
  recommendation_id uuid → recommendation.id on delete cascade
  author_id         uuid → user.id            on delete set null
  body              text not null
  created_at        timestamptz default now() not null
  updated_at        timestamptz default now() $onUpdate not null
  deleted_at        timestamptz               -- soft-delete (author/admin)
  index (recommendation_id) where deleted_at is null
```

Notes:
- `recommendation_photo.file_id` is **unique** (1:1 photo↔file) with `on delete restrict`, so a photo's byte cleanup flows through the service, not a stray FK cascade. `sort_order` is **not** uniquely constrained per place — reordering is a plain rewrite of the column (unique constraints make swaps painful); ties break on `created_at`/`id`. The ~10-photo cap and the "≥1 photo" rule are **check-first** in the service (CLAUDE.md "domain invariants are check-first"), not CHECK constraints (they count rows).
- `author_id` / comment `author_id` use `set null` so content outlives a removed owner, consistent with the event tables in ADR-0010. `recommendation_tag.tag_id` uses `on delete restrict` so a curated tag can't vanish out from under places (tags are admin-curated and rarely removed).
- All `on delete cascade` from `recommendation` are backstops for a **hard** delete (admin bin purge); normal deletion is a soft-delete (`deleted_at`) handled by the service, which also soft-deletes the child `file` rows. This mirrors the document pattern.

**System tags** are seeded by a data-only migration (`drizzle-kit generate --custom --name=seed_system_tags`): `restaurant, anchorage, pier, cove, beach, marina, bar, snorkeling, provisioning, viewpoint`. Each has a matching `m.tag_<slug>()` message and a `slug → m.tag_<slug>()` entry in `src/components/recommendation/tagLabels.ts`.

### Storage / EXIF flow (the avatar three-step, reused per photo)

```
Client                                    Server (oRPC)                         Public Blob store
──────                                    ─────────────                         ─────────────────
1. for each chosen file:
   exifr.gps(file) → { lat, lng } | null  (read BEFORE any HEIC→JPEG transcode)
   location = first file with GPS, else manual on Lefkada
2. for each file:
   orpc.recommendation.mintImageUpload ─► procedure
   { contentType, sizeBytes, fileName }   · session + Zod (image mime, size cap)
                                          · pathname recommendations/{userId}/{uuid}.{ext}
                                          · storage.mintUploadToken({ access:'public', ... })
3. PUT bytes (runUploadFlow) ───────────────────────────────────────────────►  PUT  (per file)
4. orpc.recommendation.create  ─────────► procedure
   { title, description?, lat, lng,       · for each photo: stripEnvPrefix(pathname)
     tagIds, photos:[{ pathname, mime,        .startsWith('recommendations/{userId}/')
     sizeBytes }] }                          + storage.head('public', pathname) — verify blob exists
                                          · service tx: insert recommendation
                                            + N file rows + N recommendation_photo rows
                                            + M recommendation_tag rows
                                          · for each fileId: queue.publish('blurhash',
                                            { fileId, kind:'recommendation' })
                                          · realtime.publish({ kind:'recommendation.changed' },
                                            { source:userId })
5. invalidateQueries(orpc.recommendation.key())
```

This is the avatar flow (`src/lib/orpc/procedures/image.ts`, `src/components/user/AvatarUpload.tsx`, `runUploadFlow` in `src/lib/effects/storage/clientUpload.ts`) reused — the new server work is verifying *each* uploaded photo, writing the recommendation + photo + tag rows in one transaction, and enqueuing a `'recommendation'` blurhash job per photo.

### Service / procedure sketch

Services own all DB access (ADR-0002). Procedures are thin glue that surface domain errors as **code-only typed oRPC errors**, following the `document`/`folder` routers — **not** the older `rethrowAsORPC`-to-Swedish shape. Per the 2026-06-13 ADR-0002 amendment:

- Each router declares a `recommendationErrors` / `commentErrors` map — `{ CODE: { status } } satisfies Record<<Entity>DomainErrorCode, { status: number }>`. The `satisfies` locks the keys to the domain code union, so adding a domain code **forces** a new entry (compile error otherwise). Attach with `.errors(...)` on each mutating procedure.
- In the handler: `try { … } catch (err) { if (err instanceof RecommendationDomainError) throw errors[err.code](); throw err }`. **Status only — no Swedish on the backend.**
- The client localizes by code via `src/lib/orpc/{recommendation,comment}ErrorMessage.ts` (type-only import of the code union, exhaustive `switch` → `m.*()`), so `isDefinedError(err)` narrows `err.code`.
- **Boundary/validation codes** that aren't domain codes (upload-only `INVALID_PATH`, `FILE_NOT_IN_STORAGE`) are spread into the `create` procedure's `.errors({ ...recommendationErrors, INVALID_PATH: { status: 403 }, FILE_NOT_IN_STORAGE: { status: 404 } })` and thrown directly, exactly as `confirmDocumentUpload` does. Status-only; no client message mapping.
- **`tag` has no domain errors** (read-only, seeded) and `like.toggle` has only `NOT_FOUND` — no client message map needed for tags.

```
src/lib/services/recommendation/   recommendation.ts, errors.ts, index.ts, recommendation.test.ts
  listRecommendations(viewerId)    active rows + cover/photos (pathname + blurhash, ordered) + author
                                   + aggregated tagIds + likeCount + likedByMe, in one payload
  findRecommendation(id, viewerId)
  createRecommendation(input)      one tx: recommendation → N file rows → N recommendation_photo
                                   → M recommendation_tag joins (≥1 photo, ≤~10 — check-first)
  updateRecommendation(id, actor)  author-or-admin; edit title/desc/lat/lng/tags; add/remove photos
  reorderPhotos(id, orderedIds, actor)  author-or-admin; rewrites sort_order
  softDeleteRecommendation(id, actor)   author-or-admin; sets deleted_at, soft-deletes child file rows
  RecommendationDomainError codes: NOT_FOUND | CANNOT_EDIT_OTHERS_RECOMMENDATION
                                 | CANNOT_DELETE_OTHERS_RECOMMENDATION
                                 | NO_PHOTOS | TOO_MANY_PHOTOS   (extend as invariants land)

src/lib/services/tag/              tag.ts, index.ts, tag.test.ts
  listTags()                       seeded set, ordered by sort_order  (no create, no errors)

src/lib/services/recommendationLike/   like.ts, index.ts, like.test.ts
  toggleLike(recommendationId, userId) → { liked, count }   (NOT_FOUND if the place is gone)

src/lib/services/recommendationComment/  comment.ts, errors.ts, index.ts, comment.test.ts
  listComments(recommendationId)
  createComment(recommendationId, authorId, body)   trim/validate (EMPTY_BODY at the boundary)
  softDeleteComment(commentId, actor)               author-or-admin
  RecommendationCommentDomainError codes: NOT_FOUND | CANNOT_DELETE_OTHERS_COMMENT
```

```
src/lib/orpc/procedures/recommendation.ts (+ register in router.ts)
  recommendationErrors = { …codes: { status } } satisfies Record<RecommendationDomainErrorCode, …>
  commentErrors        = { …codes: { status } } satisfies Record<RecommendationCommentDomainErrorCode, …>

  mintImageUpload   protectedProcedure                      image mime + size cap → public mint token
  create            protectedProcedure .errors({ ...recommendationErrors,
                                         INVALID_PATH, FILE_NOT_IN_STORAGE })
                                         per-photo ownership-check + storage.head →
                                         service (catch → errors[code]()) → blurhash enqueue → publish
  list              protectedProcedure
  get               protectedProcedure  (direct-link detail)
  update            protectedProcedure .errors(recommendationErrors)  catch → errors[code]() → publish
  reorderPhotos     protectedProcedure .errors(recommendationErrors)  catch → errors[code]() → publish
  softDelete        protectedProcedure .errors(recommendationErrors)  catch → errors[code]() → publish
  like.toggle       protectedProcedure .errors({ NOT_FOUND })         → publish recommendation.changed
  comment.list      protectedProcedure
  comment.create    protectedProcedure .errors(commentErrors)         → publish recommendation.changed
  comment.softDelete protectedProcedure .errors(commentErrors)        → publish recommendation.changed
  tag.list          protectedProcedure

src/lib/orpc/recommendationErrorMessage.ts, commentErrorMessage.ts   client code → m.*() (exhaustive switch)

src/lib/queue/handlers/blurhash.ts      + 'recommendation' kind → fileService.setBlurhash(fileId, hash);
                                        skips the `if (msg.kind === 'avatar')` denormalization block
                                        (same as the 'document' kind)
src/lib/effects/realtime/types.ts       + recommendation.changed
src/hooks/useRealtimeSync.ts            + dispatch arm → invalidate orpc.recommendation.key()
```

The public `file` rows are inserted inline in `recommendationService.createRecommendation`'s tx, mirroring the avatar insert shape. Extract a shared `createPublicFile` helper only if a third caller appears (avatars + recommendations would be two; today extracting would be shallow).

### Image tiers

Three sizes from each public-store original via the `unpic` transformer (`src/lib/image/transformer.ts`):

- **orb** — reuse the avatar `<Avatar>` / transformer `<img>` at ~64px (circular), using the **cover** photo.
- **gallery thumbnail** — ~400px (200 @2×) in the detail carousel.
- **full** — a bounded ~2048px transform, opened on tap.

`file.blurhash` is the placeholder at each tier. No worker, no `thumbnailPathname`, no separate WebP. In prod the transformer routes the `*.public.blob.vercel-storage.com` URL through `/_vercel/image?url=…&w=…`; in dev it passes the raw URL through (full bytes per size — fine at this scale).

### UI surface (`src/components/recommendation/`, `src/routes/_authenticated/recommendations.tsx`)

- `RecommendationMap` — **client-only** `<Map>` from `@vis.gl/react-maplibre` (the `mounted`-guard idiom from Decision §1) with the MapTiler `mapStyle`, Lefkada `initialViewState`, **`fitBounds` to all places** on load, `NavigationControl`. Orbs are `<Marker>`s whose content is a memoized (`React.memo`) circular cover-thumbnail child so markers don't re-render on pan; a tag-filter chip row narrows orbs client-side; liked spots get a subtle size/badge premiering.
- `RecommendationList` — the same places as a card/list grid sharing the tag filter, with a sort control: **newest / most-loved / nearest-me** (the last reads the browser Geolocation API and sorts via `haversineKm`, silently unsorted on deny). A view toggle (map ⇄ list) sits in the page header.
- `RecommendationDetailDialog` — responsive `<Dialog>` with URL state (ADR-0013): a **photo carousel** (gallery thumb → full on tap), title, description, author, tag chips, a **like button + count**, and a **comment thread** (`CommentThread` + `CommentComposer`, author-or-admin delete).
- **Create/edit editor — a dedicated route** (`/recommendations/new`, `/recommendations/$id/edit`), per ADR-0013's "complex/large/growing forms get a dedicated route" (it names this editor explicitly): `useAppForm` with a **multi-photo uploader** (`runUploadFlow` per file, add/remove/drag-reorder, cover = first), `TextField` title, a multiline description (reuse a shadcn `<Textarea>` via `form.AppField`; promote to a bound `TextAreaField` only if a second form needs it), a **tag picker** (multi-select over the fixed set), and a **location picker** (a mini MapLibre `<Map>` with one `<Marker draggable>`, pre-filled from EXIF). The pickers integrate via raw `<form.AppField>` render-props that push values with `field.handleChange(...)` — **never** `useState` for field values (ADR-0005).
- `tagLabels.ts` — a typed registry `Record<TagSlug, () => string>` mapping `slug → m.tag_<slug>()`, so a missing entry is a compile error; a `<TagChip>` renders tags through the registry. Adding a tag = seed migration + `m.tag_<slug>()` message + registry entry.
- `src/utils/geo.ts` — a pure `haversineKm(a, b)`; the "närmast mig" sort reads the browser Geolocation API and sorts the loaded places in JS.
- `src/lib/files/exif.ts` — wraps `exifr.gps(file)` → `{ lat, lng } | null`, called on each original file before the HEIC transcode (reusing the existing `isHeicCandidate`/`transcodeHeicToJpeg` helpers). `gps()` reads only the EXIF header (sub-ms), so no web worker is needed.
- Nav: a `MapPin` entry in `src/components/AppSidebar.tsx` `mainNavItems` (URL `/recommendations`; Swedish label, e.g. "Platser"); store the `m.*` function, call at render.

**Accessibility & responsive** (CLAUDE.md mandates responsive on every screen):
- *Mobile* — near-full-height map (`h-[…] md:h-[…]`, no fixed px), touch-sized `NavigationControl`, orb hit targets ≥44px; the location picker opens as a full-screen overlay rather than a cramped in-dialog map; the list is the comfortable default on small screens.
- *Desktop* — bounded map height; detail dialog `sm:max-w-*` (existing shadcn pattern); the editor route uses the standard `prose`/form container.
- *Keyboard/ARIA* — orbs are Tab-navigable and open on Enter; MapLibre `keyboard` interactions stay on; markers carry `aria-label="<place name>"`; the carousel and dialogs trap focus (Radix).

### Marker rendering — revisit trigger

At dozens of orbs, React `<Marker>` components are fine. If recommendations ever grow to ~100+, switch the orb layer from per-marker React components to a single GeoJSON symbol layer (lower React + GPU overhead). Captured as a revisit trigger, not a v1 requirement.

---

## Build sequence (one PR per slice)

The feature is large; it ships as a series of **atomic, independently testable PRs** (squash-merge, "one concern per PR"). Each slice can be reviewed, tested, and iterated on in isolation; later slices add tables/procedures additively without touching earlier migrations. Detailed per-slice plans live in `docs/plans/recommended-places/` (feature-workflow Phase 2).

| # | Slice | Lands | Tested by |
|---|---|---|---|
| 1 | **Data backbone** | `recommendation` + `recommendation_photo` + `tag` (seeded) + `recommendation_tag` schema/migrations; recommendation & tag services (+ errors + tests); `recommendation.{mintImageUpload,create,list,get,update,reorderPhotos,softDelete}` + `tag.list` procedures + client error maps; `recommendation.changed` realtime + `'recommendation'` blurhash kind | service tests (every domain-error code), node project |
| 2 | **Map + detail (read-only)** | `RecommendationMap` (client-only, fit-to-places, orbs), `RecommendationDetailDialog` (carousel, no social yet), nav entry, `/recommendations` route | live browser verification |
| 3 | **Create/edit editor** | dedicated editor route: multi-photo upload + add/remove/reorder + EXIF location picker + tag picker; `exif.ts`, `geo.ts` | live browser + service tests |
| 4 | **Likes** | `recommendation_like` schema/service/procedure + tests; `LikeButton`, orb premiering; `likeCount`/`likedByMe` folded into the list payload | service tests + browser |
| 5 | **Comments** | `recommendation_comment` schema/service (+ errors + tests)/procedures; `CommentThread` + `CommentComposer` in the detail dialog | service tests + browser |
| 6 | **List + sorts** | `RecommendationList` + map/list toggle + newest/most-loved/nearest-me sorts (Haversine + geolocation) | browser; `haversineKm` unit test |

Slices 4 and 5 carry their own migrations so each PR is self-contained. Slice 1 is the only one that must land before the rest; 2→6 are largely sequential by UI dependency but each is its own reviewable unit.

---

## Consequences

**Positive**:
- Reuses five existing seams (storage, realtime, queue, service, forms) essentially unchanged; the feature is a consumer.
- The open map engine keeps the tile provider reversible — a URL/key swap, not a rewrite.
- Photos ride the proven avatar byte-path (one stored original each, on-demand sizes, blurhash placeholder) — multi-photo is a join table, not new byte machinery.
- Distance is one pure, testable function; location is two ordinary columns.
- Tags are a tiny seeded lookup with consistent, localized labels — no write-path, no dedup, no error codes.
- Likes and comments make the map *living* from day one, and slice cleanly into their own PRs.

**Negative**:
- New client dependencies (`maplibre-gl`, `@vis.gl/react-maplibre`, `exifr`) add bundle weight; the map view is client-only (no SSR).
- A wider first feature than the 2026-06-14 draft — mitigated by the sliced build (each slice an atomic, testable PR).
- `VITE_MAPTILER_API_KEY` is client-exposed; mitigated by HTTP-referrer restriction (it is not a secret).
- EXIF GPS isn't always present; mitigated by manual placement (location is always editable).
- The provider seam is **one-adapter, not yet proven** — it buys reversibility (a config swap), not demonstrated depth, until a second adapter lands. We accept this, as ADR-0006 accepts it for R2.
- Adding a tag needs a migration + message + registry entry (no runtime tag creation) — an accepted cost of the curated-set choice.

**Revisit triggers** — re-open this ADR if any of these change:

1. **Recommendations grow large, or server-side radius filtering is needed.** Adopt PostGIS `geography(Point,4326)` (Alternative A) — the columns already hold WGS84 coordinates, so the migration is additive. (Also the trigger to swap per-marker React orbs for a GeoJSON symbol layer.)
2. **MapTiler's free tier is strained or its terms change.** Swap the provider (Stadia / OpenFreeMap) or self-host a Protomaps PMTiles extract in the public Blob store — engine and components unchanged.
3. **Owners want their own tags.** Re-introduce the system+custom tag duality (Alternative C) — `recommendation_tag` already references a `tag` table, so adding `label`/`created_by`/dedup is additive.
4. **A real "private recommendations" need appears.** Add a visibility check in the service reads like every other domain rule — *not* Postgres RLS (per ADR-0010 Alternative N).
5. **EXIF reliability proves poor in practice.** Revisit the guess step (e.g. reverse-geocode hints, or default to last-used map center) — the manual fallback means this is a UX tweak, not a correctness issue.

---

## Future phases (designed, not built)

The first feature is comprehensive, so little is deferred. What remains designed-but-unbuilt:

- **Custom (user-created) tags** — Alternative C above, behind revisit trigger 3.
- **Shared "places" with multiple recommendations** — today two owners recommending the same cove create two independent points (simpler, and likes/comments already aggregate sentiment per point). A merged-place model is a future possibility, not a v1 need.
- **PostGIS / server-side proximity** and the **GeoJSON symbol-layer** orb rendering — behind revisit trigger 1.

All are additive — new columns/tables and thin procedures — and touch none of the first-feature decisions above.
