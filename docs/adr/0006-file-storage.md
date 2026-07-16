# ADR 0006 — File Storage (Vercel Blob, with R2 as documented fallback)

- **Status**: Accepted
- **Date**: 2026-05-22
- **Deciders**: Lukas
- **Decision in one line**: Use Vercel Blob behind a typed `src/lib/effects/storage/` adapter; clients mint a token + pathname via oRPC, PUT bytes directly to Blob, then confirm via a second oRPC call; metadata in Postgres. Cloudflare R2 stays documented as a drop-in replacement adapter — the effects seam means switching providers is a file swap, not a rewrite.

---

> **Amended 2026-05-23.** This ADR was written as a plan; implementation shipped over the following day with intentional departures. The Architecture, Verification, and Files sections were rewritten to match what landed. Decision rationale, Alternatives, Pricing, Consequences, and Revisit-triggers sections are unchanged. The load-bearing departures:
>
> - **Two Blob stores, not one** — `oceanview-public` (avatars) and `oceanview-private` (documents), with separate read-write tokens. Per-access routing inside the adapter; pathnames are also env-prefixed (`dev/`, `preview/`, `prod/`) so the same two stores serve all environments.
> - **Three-step oRPC upload flow, not `handleUpload`** — `orpc.{image|file}.mint*Upload` → browser PUTs to Blob with the client token → `orpc.{image|file}.confirm*Upload` writes the metadata row. No `handleUpload` helper, no `onUploadCompleted` webhook (which doesn't reach `localhost` in dev).
> - **No Vercel Image Optimization** — avatars render against the raw Blob CDN URL. `/_vercel/image` isn't served by Vite locally and requires Build Output API + `remotePatterns` config in prod we don't maintain; at our scale (avatars ≤ 5 MB, rendered ≤ 160 px) it isn't worth wiring. Future option: client-side resize before upload.
>
> **Amended 2026-05-25.** Added a third adapter (`s3`) so dev can run fully offline against a local S3-compatible container (RustFS in `compose.yaml`). Mirrors the queue layer's three-path topology (ADR-0007): `vercelBlob` in prod, `s3` for local dev when `S3_ENDPOINT` is set, `devLog` for tests and offline-without-docker. Load-bearing changes:
>
> - **`mintUploadToken` returns a discriminated union** — `{ pathname, upload: { kind: 'vercel-blob-client'; clientToken } | { kind: 'presigned-put'; url; headers? } }`. Vercel Blob keeps the SDK's client-token flow (with progress events); S3 returns a presigned PUT URL the browser PUTs to directly.
> - **Browser dispatcher** at `src/lib/effects/storage/clientUpload.ts` — `uploadFileToStorage(file, mint, opts)` switches on `mint.upload.kind` so `AvatarUpload.tsx` / `DocumentUpload.tsx` no longer touch `@vercel/blob/client.put()` directly. Progress events still work for the Vercel Blob path; the S3 path uses `fetch` + plain HTTPS PUT (no progress events without `XMLHttpRequest`, accepted tradeoff).
> - **No env-prefix in the S3 adapter** — RustFS's dev bucket *is* the env boundary; one less moving part.
> - **Public bucket → anonymous read** — `compose.yaml`'s `storage-init` sidecar runs `mc anonymous set download local/oceanview-public` so avatar URLs stored in `user.image` remain fetchable long-term without re-signing (parity with Vercel Blob's public-store behaviour). Private bucket stays auth-only and is presigned per read.
> - **Adapter selector is now lazy** — `storage.ts` dynamically imports adapters on first use (mirrors `queue.ts`), so neither the AWS SDK nor `@vercel/blob` lands in the cold-start path of the other.
>
> **Amended 2026-06-10.** Partially superseded by **ADR-0010 (Document Management)**, which split document organization (name, folder, search, soft-delete/bin, history, thumbnails) into a 1:1 `document` table over `file` with its own routers. Read these sections as historical:
>
> - **Metadata service (`src/lib/services/file/`)** — the `file` table sketch is stale: `name` and `folder` moved to the `document` table; `file` gained `blurhash`, a `size_bytes >= 0` CHECK, and `timestamptz` timestamps. Document-shaped operations (`listAllDocuments`, owner-or-admin `softDelete`, …) now live in the document service.
> - **`FileDomainError` codes** — reduced to just `NOT_FOUND`; the delete-permission rules moved with the operations (`DocumentDomainError`, e.g. `CANNOT_DELETE_OTHERS_DOCUMENT`).
> - **The Documents section and `fileRouter`** — `src/lib/orpc/procedures/file.ts` is gone, replaced by the `document`, `bin`, `folder`, and `documentSearch` routers (`procedures/{document,documentBin,documentSearch,folder}.ts`).
>
> The byte-path itself (mint → direct PUT → confirm), the avatar flow, and the storage seam remain authoritative here — ADR-0010 consumes the seam, it doesn't change it. Separately on the same date: the seam widened to six methods (`put`, `copy` — see The seam), the adapter selector gained a `VITEST` short-circuit, and pathname env-prefixing got a single exported source of truth (`envPrefix`/`stripEnvPrefix`) after a production bug — details updated in the body below.

> **Amended 2026-06-13. Prod-origin files in the Neon-branched dev DB.** Dev branches the prod Neon DB (per the dev-setup), so the dev database carries prod `file`/`document` rows — but their bytes live in the production Vercel Blob store, never in local RustFS, so opening one in dev would 404. The env-prefix is the discriminator: the `s3` adapter never prefixes its own uploads, so a `prod/` / `preview/` prefix on a pathname *is* the "byte is remote" signal. Codified as `isRemoteOriginPathname(pathname)` in `storage.ts` (true only when `S3_ENDPOINT` is set, i.e. local dev — always false in prod). Three pieces hang off it:
>
> - **`pnpm storage:sync`** (`scripts/syncProdStorage.mjs`, chained into `pnpm dev:up`) walks prod-prefixed pathnames in the dev DB, reads each byte from Vercel Blob (read-only, via the SDK directly — *not* the prefixing adapter), and PUTs it into RustFS under the same key. Idempotent (skips objects already present). Skips cleanly when `S3_ENDPOINT` or the `BLOB_*` read tokens are absent, so `dev:up` never breaks. Safe re: the `vercel env pull` guard — the running app still selects `s3` (S3_ENDPOINT wins); only this script consumes the blob tokens.
> - **A dev-only "PROD" badge** on document rows (`isRemoteOrigin` flag on `listDocuments`, rendered by `RemoteOriginBadge`) marks rows whose bytes are remote-origin.
> - **A friendly fallback** in `/api/files/{view,download}` (`remoteOriginUnavailable()`): for a remote-origin file absent from RustFS, an explanatory page instead of a redirect to a URL that 404s.
>
> **Deleting a prod-origin file in dev is safe** — prod is untouched on both axes. Soft-delete is a pure DB write on the **dev Neon branch** (branch writes never propagate to prod). Hard-delete (admin bin purge) deletes the dev-branch row, then `storage.delete` hits **local RustFS** (idempotent no-op on a missing key); it cannot reach prod Vercel Blob — the running app has no blob tokens wired in and uses the `s3` adapter/endpoint.

> **Amended 2026-06-15. Prod-origin files in Vercel preview — read-through + write-protection.** Preview deployments also branch the prod Neon DB, so prod `file` rows surface in preview with their `prod/` pathname — and preview *shares the same two Vercel Blob stores* as prod (only the env prefix differs). Two bugs and a hazard:
>
> - **Read ("Blob not found").** The `vercelBlob` adapter only treated the *current* env's prefix as "already prefixed", so in preview a `prod/documents/x` was re-prefixed to `preview/prod/documents/x` → 404. Fixed by generalizing that helper to **`applyEnvPrefix`** (in `storage.ts`), which — mirroring `stripEnvPrefix` — leaves any `prod/`/`preview/`/`dev/`-prefixed pathname untouched and only prepends the current prefix to *logical* paths. Preview now reads prod bytes directly from the shared store. Also fixes prod-origin avatars/place photos in preview.
> - **Marking.** `isRemoteOriginPathname` was `S3_ENDPOINT`-gated (dev-only). Redefined as "the pathname's env prefix ≠ the current env's" — now true in preview for prod files (and unchanged in dev). So the **PROD badge** shows in preview too; its tooltip is env-aware (`import.meta.env.DEV`): "run `pnpm storage:sync`" in dev, "read-only, shown from the shared prod store" in preview.
> - **Write-protection (the hazard).** Because the store is shared, a preview hard-delete / rename / avatar-replace would otherwise mutate the *real prod byte*. Guarded two ways: the `vercelBlob` adapter **no-ops `delete`/`copy` on a foreign-origin pathname** (a backstop that can never reach prod), and `renameDocument` skips the physical byte move for a foreign-origin file (display-name rename still commits; byte keeps its old basename — the same tolerated degradation as a storage failure). Soft-delete is a branch-local DB write, so it was already prod-safe. Net: preview is *read-through, write-isolated* against prod bytes — symmetric with dev's RustFS isolation.

> **Amended 2026-06-30. Server-side HEIC transcode worker + the iPhone embedded-thumbnail caveat.** A new `heic_transcode` derived-asset worker (PR #61; design spec `docs/superpowers/specs/2026-06-29-server-side-heic-transcode-design.md`) moved the HEIC→JPEG transcode off the client — it used to run `heic-to` (libheif wasm, ~3 MB) in the browser and freeze the UI for seconds — into the queue, under this ADR's storage seam. It's the same **sanctioned derived-asset worker exception** as `image_thumbnail`/`blurhash` (see The byte-path): it `getReadUrl`s the uploaded HEIC, decodes with `heic-convert` (libheif wasm, Node — `sharp` can't decode HEIC, the prebuilt libvips omits libheif), and either *replaces* the file with a JPEG (avatar/recommendation: `put` the JPEG → repoint the `file` row → `delete` the original HEIC) or *derives* a public WebP thumbnail keeping the original (documents). Clients now upload **raw HEIC** (the mint allow-list gained `image/heic`/`image/heif`); a new nullable `file.transcode_failed_at` records a permanent decode failure so the UI shows a "couldn't process" state. Three notes that bear on this ADR's seam and the Avatars section:
>
> - **The worker sets `user.image` without a Better Auth session.** The Avatars-section rule "`user.image` update goes through `auth.api.updateUser`" holds for the synchronous confirm path, but the worker has no session — it repoints `user.image` directly via `userService.setImage` (a plain `db.update`). Accepted: the 5-minute cookie-cache staleness that rule guards against is moot in a background job, and the worker publishes `user.changed` to force a refetch. Relatedly, `confirmAvatarUpload` now **clears `user.image` to null** in the HEIC branch (rather than leaving it pointing at the just-deleted previous blob or the not-yet-renderable HEIC), so shared surfaces fall back to initials during the pending window; the worker sets the JPEG URL on completion.
> - **No instant client preview for native iPhone HEICs.** The design assumed the client could display the HEIC's embedded EXIF JPEG thumbnail instantly during the pending window, and called a missing one "rare for iPhone." That assumption is **wrong**: native iPhone HEICs store their preview as an **HEVC `thmb` derived item** in the HEIF container, *not* an extractable EXIF IFD1 JPEG, so `exifreader`'s `tags.Thumbnail` is null for them (verified on a real `IMG_*.HEIC`: GPS present, zero `ff d8 ff` JPEG markers anywhere in the file). The feature degrades gracefully — `readImageMetaFromFile` returns `{ thumbnail: null }` and the tile/avatar renders a neutral/blurhash placeholder until the worker's JPEG arrives — but there is **no** instant preview for the common case. A real one would require decoding the HEVC `thmb` (a follow-up, out of scope). GPS extraction is unaffected (that's plain EXIF, not the thumbnail). The primary goals — no client freeze, server transcode, ~3 MB smaller bundle — are fully met.
> - **Access tiers unchanged.** The worker reads/writes/deletes on the `file` row's own `access` tier; document originals stay `private`, and only the downscaled public WebP thumbnail goes to the `public` store — identical to `image_thumbnail` and the derived-asset model in The byte-path.

---

## Context

Oceanview has file storage scaffolded but **unwired**:

- `user.image` exists on the Better Auth schema (`src/lib/db/schema/betterAuth.ts:9`) but is unused — `UserCard` and `admin/users.tsx` render initials via `AvatarFallback` only.
- `src/routes/_authenticated/documents.tsx` is a placeholder for a future file library.
- `src/lib/effects/` follows the typed-adapter pattern from ADR-0001 (`email/` is the canonical template) — no `storage/` subdirectory yet.

The original decision (recorded in `CLAUDE.md`) was **Cloudflare R2, not Vercel Blob (zero egress fees)**, with the planned pattern: browser PUTs directly to R2 via a presigned URL minted server-side; Vercel functions never see file bytes; Postgres holds metadata only.

That reasoning was correct in the abstract but **overweighted for our actual workload** (10–20 users, ~1–2 GB total storage, a few GB/month egress at most). At this scale, the deciding factors are operational simplicity and how much code we want to write — not egress costs that round to zero either way. With the app already on Vercel + Neon + the Vercel Marketplace, consolidating onto Vercel Blob removes a provider account, a secret-management surface, and the hand-rolled S3 presigner we'd otherwise need to build.

The seam from ADR-0001 means the choice is **reversible**: if usage ever shifts (e.g. the document library becomes a broadly-shared archive that bumps into Hobby Blob's hard-cap behavior, or egress costs ever become meaningful), swapping to R2 is a file swap behind the existing interface — no procedures or call sites change.

This ADR captures the choice, the alternatives, the trigger conditions that would flip it back to R2, and the shape of the `effects/storage/` adapter when it lands.

---

## Decision (TL;DR)

**Use Vercel Blob, accessed through `src/lib/effects/storage/`, with client uploads as the primary path.**

Concretely:

- `src/lib/effects/storage/` follows the `email/` template: a typed `StorageEffects` interface, one adapter per backend, a barrel.
- Two adapters from day one — `adapters/vercelBlob.ts` (production, talks to both Blob stores) and `adapters/devLog.ts` (tests + offline dev). R2 lands as `adapters/r2.ts` *only if* a revisit trigger fires.
- **Two Blob stores**: `oceanview-public` (avatars) and `oceanview-private` (documents), with `BLOB_PUBLIC_READ_WRITE_TOKEN` and `BLOB_PRIVATE_READ_WRITE_TOKEN` provisioned via the Marketplace integration. The adapter picks the right token from the `access` parameter on every call.
- **Env-prefixed pathnames** — the adapter prepends `dev/`, `preview/`, or `prod/` to every pathname based on `VERCEL_ENV`. One pair of stores serves all environments with namespace isolation.
- **Three-step upload flow**, all routed through oRPC:
  1. Client calls `orpc.image.mintAvatarUpload` / `orpc.file.mintDocumentUpload` — server generates the pathname, calls `storage.mintUploadToken`, returns `{ clientToken, pathname }`.
  2. Client calls `put(pathname, file, { access, token: clientToken })` from `@vercel/blob/client` — bytes go direct to Blob.
  3. Client calls `orpc.image.confirmAvatarUpload` / `orpc.file.confirmDocumentUpload` — server runs `storage.head` to verify the blob exists, writes the metadata row (and `user.image` via `auth.api.updateUser` for avatars), publishes a realtime event.
- Bytes never traverse a Vercel Function on the user upload/download paths — same architectural property as the R2 plan. Only the *coordination* runs server-side, through typed oRPC procedures. (Derived-asset workers are the sanctioned exception — see The byte-path.)
- File metadata (`id`, `owner_id`, `pathname`, `name`, `mime`, `size_bytes`, `folder`, `access`, `uploaded_at`, `deleted_at`) lives in Postgres in a `file` table owned by `src/lib/services/file/` (ADR-0002).
- Avatars use `access: 'public'`, are stored at `avatars/{userId}/{uuid}` (per-upload UUID), and render against the raw Blob CDN URL — no Image Optimization indirection (see Architecture → Image Optimization).

The seam is the deep module: small interface (`mintUploadToken`, `head`, `delete`, `put`, `copy`, `getReadUrl`), real swap-in implementations, hidden adapter-specific plumbing. The browser-side `put` from `@vercel/blob/client` is the only place outside the adapter that touches Vercel-specific code — everything else flows through `~/lib/effects`.

---

## Alternatives considered

### A. Cloudflare R2 (the original plan)
- ➕ **Free egress, always.** Cost ceiling is impossible to hit on egress. Useful if documents ever become hot or shared widely.
- ➕ More generous storage free tier (10 GB-month vs. Vercel's smaller Hobby quota that's *shared* with other Vercel services).
- ➕ S3-compatible API — vendor-portable. Moving off Vercel later doesn't touch the storage layer.
- ➕ **Won't stop serving** when the free tier is exceeded — bills you instead. Better for a "this app must work" posture than Hobby Blob's hard cutoff.
- ➖ **Second provider account.** Another set of API keys (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`) to rotate, audit, and document.
- ➖ **More code to write**: AWS SDK v3 (or `aws4fetch`) presigner, completion endpoint, signed-read URLs for private documents. There is no R2-native client-upload helper — the two-step (mint URL → confirm) flow is yours to build. *(Largely evaporated since 2026-05-25: `adapters/s3.ts` is exactly that AWS-SDK presigner, built for the local RustFS dev path.)*
- ➖ Manual env-var setup (not auto-provisioned by the Vercel Marketplace).
- ➖ No first-class dashboard inside Vercel for usage/inspection.
- **Verdict**: correct for a workload where egress would actually matter. Wrong tradeoff for 20 users. Kept available as a fallback; documented trigger conditions below. **Refreshed 2026-06-10**: since `adapters/s3.ts` is a working AWS-SDK presigner, the R2 swap is now mostly endpoint/credential config rather than new code. Known gaps in the s3 path if promoted to prod: no upload progress events (plain `fetch` PUT in `clientUpload.ts`), no env-prefixing (the dev bucket is the env boundary), and a presigned PUT cannot enforce `maxBytes` (noted in the adapter; size is still validated at the mint/confirm boundaries).

### B. Vercel Blob (chosen)
- ➕ **One provider, one bill, one dashboard surface.** Marketplace integration auto-provisions a `BLOB_READ_WRITE_TOKEN` per store; we rename to `BLOB_PUBLIC_*` / `BLOB_PRIVATE_*` to support the two-store split (see Decision).
- ➕ **First-party client-upload SDK** with `@vercel/blob/client.upload()` — built-in presigning, token-minting, and `onUploadCompleted` callback. Materially less code than rolling R2 + S3 SDK + presigner.
- ➕ Public + private access in one API; private files served via `get()` from a Function when ACL is needed (avatars stay public; documents likely stay private).
- ➕ Auto-CDN — Blob Data Transfer uses Vercel's edge network without extra config.
- ➕ Plays well with the existing effects pattern — `adapters/vercelBlob.ts` is a thin wrapper.
- ➖ **Egress is paid** ($0.05/GB Blob Data Transfer past the Pro 100 GB include). Negligible at our scale, but a real cost cliff if documents ever go public/viral. Trigger documented below.
- ➖ **Hobby quota is shared and hard-capped.** If Blob hits its limit, it stops serving for up to 30 days. Avatars and documents both go dark — not just the offending feature. This is the only Blob property that meaningfully argues for R2 at our scale.
- ➖ Dashboard interactions count as operations. A handful of admin clicks can quietly burn Advanced Operations quota.
- ➖ **Vendor lock-in.** The SDK isn't S3-compatible. A future migration requires rewriting the storage adapter (which is exactly what the `effects/storage/` indirection is for).
- ➖ Multipart uploads cost more per upload (each part = 1 Advanced Op).
- **Verdict**: chosen. The "less code + one provider" gains outweigh the egress and hard-cap concerns at this scale. Hard-cap risk is mitigated by quota observability + the fast adapter-swap escape hatch.

### C. Both at once (R2 for documents, Blob for avatars)
- ➕ Avatars stay close to Vercel Image Optimization with zero config; documents get free egress.
- ➖ Two adapters in production from day one for orthogonal reasons; two sets of secrets; two failure modes; two billing dashboards. The cognitive cost is real, the benefit is hypothetical (we don't have a document workload that benefits from free egress yet).
- **Verdict**: don't. Pick one default; let the seam carry the second when there's a real reason.

### D. Supabase Storage / S3 directly / Backblaze B2
- ➕ All viable; all S3-compatible (Supabase, B2 are; S3 itself is).
- ➖ Either a third vendor account (Supabase / B2) or AWS billing complexity (S3). Same con as R2 (second provider) without R2's free-egress upside.
- **Verdict**: don't. R2 remains the documented fallback; no need to consider others until R2 itself is exhausted.

### E. Self-host (MinIO on a VPS)
- ➕ Total control. Free egress (modulo bandwidth caps).
- ➖ Adds the only piece of infrastructure Oceanview currently lacks (a server to babysit). Conflicts with the "free tier first, no ops burden" posture in CLAUDE.md.
- **Verdict**: don't. Not until Oceanview becomes a different kind of project.

---

## Architecture

### The `src/lib/effects/storage/` namespace

Mirrors `src/lib/effects/email/`. Where `email/` owns SMTP transport, `storage/` owns object storage:

```
src/lib/effects/
  index.ts                          barrel — re-exports effects.email, effects.storage, …
  storage/
    index.ts                        barrel
    storage.ts                      typed interface + adapter selector + envPrefix/stripEnvPrefix
    clientUpload.ts                 browser dispatcher — uploadFileToStorage + runUploadFlow (mint → PUT → confirm)
    adapters/
      vercelBlob.ts                 production adapter — talks to both Blob stores (per-access token), env-prefixes pathnames
      s3.ts                         S3-compatible adapter (RustFS local dev; AWS-SDK presigner)
      s3.test.ts                    s3 adapter tests
      devLog.ts                     no-op adapter (logs + stub return values; used in tests + offline dev)
    storage.test.ts                 interface contract test against devLog
```

The adapter selector resolves in this order:

1. **`VITEST === 'true'` → `devLog`** (added 2026-06-10). Tests must never reach live storage; `test/setup.ts` loads `.env` via dotenv, so without this short-circuit a test touching storage would pick the `s3` adapter and write to RustFS. This supersedes the earlier "tests use devLog via `STORAGE_ADAPTER=devLog`" arrangement — the env var is no longer needed for tests.
2. **`STORAGE_ADAPTER=devLog` → `devLog`** — explicit override for ad-hoc offline runs.
3. **`S3_ENDPOINT` set → `s3`** — local dev against RustFS; takes precedence over `BLOB_*` so a `vercel env pull` accident doesn't route dev uploads at the real Blob CDN.
4. **Both `BLOB_PUBLIC_READ_WRITE_TOKEN` and `BLOB_PRIVATE_READ_WRITE_TOKEN` set → `vercelBlob`**.
5. **Fallback → `devLog`**.

The future R2 adapter would land as `adapters/r2.ts` with no other changes; the selector would prefer R2 when `R2_*` env vars are set — and since `adapters/s3.ts` already implements the presigned-PUT shape against an S3-compatible API, R2 is closer to a config variant of that adapter than a new one.

### The seam

```ts
// src/lib/effects/storage/storage.ts
export type MintUploadResult = {
  pathname: string
  upload:
    | { kind: 'vercel-blob-client'; clientToken: string }
    | { kind: 'presigned-put'; url: string; headers?: Record<string, string> }
}

export interface StorageEffects {
  /**
   * Mint the credential the browser needs to upload bytes directly. The
   * adapter may env-prefix the input pathname; the *returned* pathname is
   * what the browser must round-trip on confirm. `upload` is a discriminated
   * union so the client picks the right transport per backend.
   */
  mintUploadToken(input: {
    access: 'public' | 'private'
    pathname: string
    contentType: string
    maxBytes: number
  }): Promise<MintUploadResult>

  /** Existence + metadata check. Returns null when the blob does not exist. */
  head(access: 'public' | 'private', pathname: string): Promise<{
    url: string
    contentType: string
    size: number
  } | null>

  delete(access: 'public' | 'private', pathname: string): Promise<void>

  /**
   * Write bytes from a server-side context — background workers producing
   * derived assets (e.g. the thumbnail worker storing a WebP), NOT the oRPC
   * upload path; browsers still upload via mintUploadToken.
   */
  put(access: 'public' | 'private', pathname: string, bytes: Buffer, contentType: string): Promise<void>

  /**
   * Server-side storage-to-storage copy within the same access store — used to
   * "rename" a document's byte without the bytes transiting a Function (the
   * prod download filename is the pathname basename). `contentType` is required
   * because Vercel Blob's copy doesn't carry the source content type over.
   */
  copy(access: 'public' | 'private', fromPathname: string, toPathname: string, contentType: string): Promise<void>

  /**
   * Download URL. `private` is signed + time-limited; `public` is canonical
   * (Vercel Blob) or stable bucket URL (S3 dev). `opts.downloadFilename`
   * forces `Content-Disposition: attachment` under that name — honored on the
   * S3 (dev) signed-URL path; Vercel Blob (prod) ignores it and serves the
   * pathname basename, which `renameDocument` keeps in sync via copy().
   */
  getReadUrl(
    access: 'public' | 'private',
    pathname: string,
    ttlSeconds: number,
    opts?: { downloadFilename?: string },
  ): Promise<string>
}

export const storage: StorageEffects = pickAdapter()  // lazy: adapters dynamically imported on first use
```

The interface is **intentionally backend-neutral**. The discriminated `upload` payload is the seam: Vercel Blob returns `{ kind: 'vercel-blob-client', clientToken }` (browser uses `@vercel/blob/client.put()` so progress events still work); S3-compatible backends (RustFS for local dev, R2 the day we ever swap to it) return `{ kind: 'presigned-put', url }` (browser does a plain HTTPS PUT). The browser dispatcher in `clientUpload.ts` switches on `kind`, so the upload components (`src/components/user/AvatarUpload.tsx`, the document upload queue in `src/components/document/upload/`) only know about the seam — they call `runUploadFlow` (the shared mint → PUT → confirm sequence in `clientUpload.ts`) rather than any SDK.

**Env-prefixing and `stripEnvPrefix` (added 2026-06-10).** The `vercelBlob` adapter prepends `prod/` / `preview/` / `dev/` (from `VERCEL_ENV`) to every pathname; `s3` and `devLog` don't prefix. Crucially, `mintUploadToken` returns the **prefixed** pathname, and that is what the browser round-trips to the confirm procedure — so confirm-time shape/ownership checks must validate the *logical* form: `stripEnvPrefix(input.pathname).startsWith('documents/')` in `confirmDocumentUpload`, and the `avatars/{userId}/` equivalent in `confirmAvatarUpload`. Both `envPrefix()` and `stripEnvPrefix()` are exported from `storage.ts` — one source of truth shared with the adapter, so prefixing and stripping can't drift. This codified a real production bug: `confirmDocumentUpload`'s previous bare `startsWith('documents/')` rejected every production document upload, because prod pathnames arrive as `prod/documents/…`.

### The byte-path

```
Client                                   Server (oRPC)                          Vercel Blob
──────                                   ─────────────                          ───────────
1. handleFile(file)
   └─ orpc.image.mintAvatarUpload  ───►  procedure
   (or file.mintDocumentUpload)          · session + Zod validation
                                         · generate pathname (server-owned)
                                         · storage.mintUploadToken(...)
                                         · return { clientToken, pathname }
2. put(pathname, file, { access, token })  ─────────────────────────────────►  PUT bytes
                                                                               ◄─ { url, contentType, ... }
3. orpc.image.confirmAvatarUpload  ───►  procedure
   (or file.confirmDocumentUpload)       · storage.head(access, pathname) — verify
                                         · avatar: replaceAvatarForUser + delete previous blobs
                                                   + auth.api.updateUser({ image })
                                           document: fileService.confirmUpload(...)
                                         · realtime.publish({ kind: 'user.changed' | 'document.changed' })
4. invalidateQueries(...)
```

The diagram shows the byte path only — the confirm procedures also enqueue `blurhash` / `image_thumbnail` jobs for image mimes after the metadata write (ADR-0007 / ADR-0010), so don't read it as the complete post-confirm fan-out.

Two oRPC procedure calls (mint + confirm) bracket the direct PUT to Blob. **Bytes never traverse a Vercel Function on the user upload/download paths**, same architectural property the original R2 plan wanted. The sanctioned exception is derived-asset workers: the `image_thumbnail` handler fetches the original and `storage.put`s a WebP, and the `blurhash` handler fetches it to compute a hash — server compute by design (ADR-0007/0010). `storage.copy` (rename) is storage-to-storage; no bytes transit a Function there either. The mint procedure owns the pathname (browser can't choose where bytes land); the confirm procedure verifies the blob exists via `storage.head` (a fake-confirm with no actual upload is rejected) and re-checks ownership (`stripEnvPrefix(pathname).startsWith('avatars/{userId}/')` for avatars).

Why three steps instead of Vercel's `handleUpload` helper: `handleUpload` uses a webhook callback (`onUploadCompleted`) that requires Blob's servers to POST back to the app's URL after the upload completes. That doesn't reach `localhost` in dev, and on production it adds a round-trip. Our three-step shape is webhook-free, client-driven, and reuses the project's standard oRPC mutation pattern.

### Metadata service — `src/lib/services/file/`

Follows ADR-0002. Owns the `file` Postgres table (holds rows for both avatars and documents — the `access` column discriminates):

```ts
// src/lib/db/schema/file.ts
export const fileAccessEnum = pgEnum('file_access', ['public', 'private'])

export const file = pgTable('file', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  pathname: text('pathname').notNull().unique(),       // env-prefixed; the canonical handle
  name: text('name').notNull(),                        // original filename
  mime: text('mime').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  folder: text('folder'),                              // null = root (private only)
  access: fileAccessEnum('access').notNull(),
  uploadedAt: timestamp('uploaded_at').defaultNow().notNull(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('file_owner_id_idx').on(table.ownerId),
  index('file_access_idx').on(table.access),
])
```

No `blobUrl` column — `pathname` is the canonical handle. Private read URLs are minted on demand via `storage.getReadUrl(pathname, ttl)`; public read URLs come from `storage.head().url` at confirm time (and for avatars, are persisted to `user.image` via Better Auth's update API).

Operations: `confirmUpload`, `listAllDocuments` (shared library, joined with uploader name), `replaceAvatarForUser` (transactional: insert new public row + soft-delete previous public rows + return previous pathnames for blob cleanup), `softDelete` (owner-or-admin gate; rejects when called on a public row), `findById`, `findActiveById`.

`FileDomainError` codes: `NOT_FOUND`, `CANNOT_DELETE_OTHERS_FILE`, `CANNOT_DELETE_AVATAR_VIA_DOCUMENT_DELETE`. Size + MIME validation happens at the procedure layer (Zod) before reaching the service.

### Avatars

`user.image` is the Better Auth-managed column for the user's profile picture URL. Avatars use the same `effects.storage` interface with `access: 'public'`, a pathname of `avatars/{userId}/{uuid}` (server-generated UUID per upload — not a stable per-user path), max 5 MB, and a MIME allowlist (`image/jpeg`, `image/png`, `image/webp`). Bound by the `imageRouter` procedures.

**Per-upload pathnames** mean each new avatar lands at a fresh URL. `replaceAvatarForUser` (the service helper) soft-deletes any previously active public row for that user and returns their pathnames; the confirm procedure then calls `storage.delete('public', p)` for each. Net effect: one live avatar per user, every replacement gets a fresh URL automatically — no `?v=` cache-busting tricks.

**`user.image` update goes through Better Auth.** The confirm procedure calls `auth.api.updateUser({ body: { image: blob.url }, headers: context.headers })`. Better Auth's update endpoint writes the DB *and* refreshes the session `session_data` cookie (the cookie cache from `src/lib/auth.ts`). A direct `db.update(user).set({ image })` would leave the cookie cache stale for up to 5 minutes — already learned that the hard way.

**Rendering**: `<AvatarImage src={user.image}>` against the raw Vercel Blob CDN URL. No `/_vercel/image` indirection — see Image Optimization below.

### Documents

Documents (private store) work the same shape — `fileRouter.mintDocumentUpload` + `fileRouter.confirmDocumentUpload` — with a higher size cap (25 MB) and a broader MIME allowlist (PDFs, images, Word). Pathname format: `documents/{folder?}/{uuid}-{safeFilename}`.

**Shared library, not per-owner**: every signed-in user sees all non-deleted document rows via `fileRouter.listDocuments` (joins `file` with `user` to surface the uploader's name). Only the owner or an admin can delete (`fileRouter.deleteDocument` → `fileService.softDelete` enforces it). Download is a 302-redirect route (`/api/files/download/$id`) that mints a 60-second signed URL via `storage.getReadUrl` after the session check — `<a href={...}>` lets the browser handle the file fetch natively. A sibling route `src/routes/api/files/view.$id.ts` follows the same auth-gated 302 pattern but passes no `downloadFilename`, so no `Content-Disposition: attachment` is forced — images and PDFs preview inline.

### Image Optimization — deferred, then wired via a passthrough transformer

> **Amended 2026-06-04.** Image Optimization is now wired (it was deferred at first authoring). The two original blockers were solved by a tiny **environment-aware transformer** rather than dropping the feature: `src/lib/image/transformer.ts` (an `unpic` `URLTransformer` for the `vercel` provider), consumed by `src/components/ui/avatar.tsx` via `@unpic/react`. Behaviour:
> - **Dev** (`import.meta.env.DEV`): returns the source URL unchanged — the browser fetches raw bytes straight from Blob, so `/_vercel/image` not existing on the Vite dev server is a non-issue.
> - **Prod, public-blob hosts** (`*.public.blob.vercel-storage.com`): routes through `unpic`'s `transform()`, which builds the `/_vercel/image?url=…` URL.
> - **Any other host** (e.g. static passkey provider icons not on `remotePatterns`): returns the source URL unchanged.
>
> So the "no `/_vercel/image` indirection" statements elsewhere in this ADR (Decisions row, Avatars bullet, Rendering note) are now historical — read them as "raw URL in dev / non-blob, optimized URL in prod for blob avatars". The grep check below was updated accordingly.

The original plan called for `/_vercel/image?url=...&w=...&q=80` to deliver resized avatars. We *deferred* it during the initial implementation for these reasons (since resolved by the transformer above):

- `/_vercel/image` is a Vercel-platform endpoint. **It doesn't exist on the Vite dev server** — the URL falls through to the SPA fallback and renders broken. (Solved: the transformer passes through in dev.)
- Production needs `remotePatterns` allowlisting our Blob hostnames (`*.public.blob.vercel-storage.com`). (Solved: configured; the transformer only routes those hosts and passes others through.)
- Avatars are small (≤ 5 MB, mostly < 500 KB) and rendered at 20–160 px. Browsers downscale fine — but the transformer is near-zero-cost and gives correct responsive sizing for free, so it earned its place.

**Future option** (still open): client-side resize before upload — a `canvas` / `createImageBitmap` step in `AvatarUpload.handleFile` that downscales to e.g. 256×256 WebP before `put()`. Bounds stored byte size at the source.

### Why this is a deep module (in the architecture-skill's terms)

- **Interface**: 6 typed functions (`mintUploadToken`, `head`, `delete`, `put`, `copy`, `getReadUrl`). Stable across backends.
- **Implementation**: hides per-access token routing, env-prefixing, token minting, signed-URL generation, blob existence checks. The procedure layer never imports `@vercel/blob`; the *browser* side calls `put` from `@vercel/blob/client` (necessary — that's the upload SDK), but the procedures and services see only the interface.
- **Two real adapters from day one** (`vercelBlob` + `devLog`) — the seam is real, not hypothetical, and passes ADR-0001's "deletion test".
- **Test surface = the interface**: services + procedures use the `devLog` adapter in tests via the selector's `VITEST === 'true'` short-circuit (the `STORAGE_ADAPTER=devLog` env override remains for ad-hoc use); we don't mock Blob, we have a real second implementation.

### Adding a new file kind / a third store

- **New file kind** (another uploadable entity): no storage changes. Follow ADR-0010's pattern — a 1:1 metadata table over `file`, a mint/confirm procedure pair against an existing store (`public` or `private`), post-confirm job enqueues for any derived assets.
- **A genuinely third store** (a new `access` value): this is the expensive axis. The `'public' | 'private'` union threads through every method of `StorageEffects` and every adapter — `vercelBlob`'s token routing, `s3`'s bucket map, `devLog` — plus env vars, `compose.yaml` bucket bootstrap, and `.env.example`. Expect to touch all adapters, not add one file.

---

## Pricing reference (point-in-time, verified 2026-02-27 / 2026-03-04)

Kept in this ADR so the trigger conditions below are interpretable later.

### Vercel Blob — Pro plan (Hobby quotas are smaller and shared with other Vercel services)

| Resource | Pro included | Pro overage |
|---|---|---|
| Storage | 5 GB-month | $0.023/GB-month |
| Simple ops (cache MISS, `head()`) | 100K | $0.40/1M |
| Advanced ops (`put`/`copy`/`list`) | 10K | $5.00/1M |
| Blob Data Transfer (downloads) | 100 GB | $0.05/GB |
| Edge Requests | 10M | standard CDN |
| Fast Origin Transfer (cache MISS) | 100 GB | $0.06/GB |

Notes: `del()` is free; dashboard browsing counts as Advanced Ops; multipart uploads count as multiple ops (1 start + 1/part + 1 complete); cache limit is 512 MB per blob (larger blobs MISS on every access).

### Cloudflare R2 — fallback reference

| Resource | Free tier | Paid |
|---|---|---|
| Storage | 10 GB-month | $0.015/GB-month |
| Class A ops (PUT/POST/LIST) | 1M/month | $4.50/1M |
| Class B ops (GET/HEAD) | 10M/month | $0.36/1M |
| **Egress** | **Free, always** | **Free, always** |

---

## Verification

A reader can confirm the architecture is being followed without running anything:

- `grep -rn "from '@vercel/blob" src/` — server SDK (`@vercel/blob`) imported only by `src/lib/effects/storage/adapters/vercelBlob.ts`. Browser SDK (`@vercel/blob/client`) imported only by `src/lib/effects/storage/clientUpload.ts` (the browser `put`) and `adapters/vercelBlob.ts` (server-side `generateClientTokenFromReadWriteToken`) — components never touch it; they go through `runUploadFlow`. Anywhere else is a violation.
- `grep -rn "BLOB_PUBLIC_READ_WRITE_TOKEN\|BLOB_PRIVATE_READ_WRITE_TOKEN" src/` — should match only `adapters/vercelBlob.ts` and the adapter selector in `storage.ts`. The tokens aren't read elsewhere.
- `grep -rn "handleUpload\|handleUploadUrl\|onUploadCompleted" src/` — zero hits. We don't use Vercel's webhook helper.
- `grep -rn "/_vercel/image" src/` — only a comment in `src/lib/image/transformer.ts`. The URL is never hand-built; `unpic` produces it inside that transformer (prod, public-blob hosts only). `grep -rln "lib/image/transformer" src/` finds the transformer's consumers (`src/components/ui/avatar.tsx`, `src/components/passkey/PasskeyRow.tsx`).
- `grep -rn "db\.\(select\|insert\|update\|delete\)" src/lib/effects/storage/` — zero hits. Storage adapters don't touch the DB; metadata writes are the `file` service's job (ADR-0002).
- `grep -rn "console\." src/lib/effects/storage/` — zero hits. Logging via `~/lib/logger` (ADR-0003).
- The `file` service's tests cover invariants without instantiating any storage adapter — the schema-per-test harness (`test/setup.ts`) is enough; storage calls are exercised against the `devLog` adapter via the selector's `VITEST === 'true'` short-circuit.

Manual smoke tests:

1. **`/account`** — upload an avatar (JPEG, ~200 KB). DevTools Network shows three calls bracketing the byte transfer: `POST /api/rpc` (`image.mintAvatarUpload`) → `PUT https://{publicStoreId}.public.blob.vercel-storage.com/dev/avatars/{userId}/{uuid}` → `POST /api/rpc` (`image.confirmAvatarUpload`). The avatar renders immediately; `user.image` in Postgres holds the Blob URL; the `oceanview-public` dashboard shows a new object under `dev/avatars/...`.
2. **Avatar replacement** — upload a second avatar. The previous blob disappears from the public store dashboard; the previous `file` row is soft-deleted; `user.image` now points at the new URL (cookie cache refreshes because we go through `auth.api.updateUser`).
3. **`/documents`** — upload a PDF as user A. Same three-call DevTools pattern against `document.mintDocumentUpload` + `PUT https://{privateStoreId}.private.blob.vercel-storage.com/...` + `document.confirmDocumentUpload`. Metadata row appears, file appears in the list, realtime event propagates to a second tab.
4. **Shared library** — sign in as user B in another browser. User B sees A's document and can download it via `/api/files/download/{id}` (302 redirect to a 60-second signed URL). User B does NOT see a delete button on A's row; calling `orpc.document.deleteDocument({ id })` directly returns the Swedish `CANNOT_DELETE_OTHERS_DOCUMENT`-mapped error. As an admin, the delete succeeds.
5. **Privacy** — `curl -I` the private store URL directly without a signed URL → 401/403. `curl -I` the public store URL → 200.
6. **Quota visibility** — confirm both Vercel Blob dashboards show usage; configure alerts at ~80% of the Hobby quota (the primary mitigation for the hard-cap risk).
7. **`pnpm test`** — colocated tests pass (91/91 at the time of writing); storage tests use the `devLog` adapter and never make a live Blob call.

---

## Files

**New** (added while wiring this ADR):
- `src/lib/effects/storage/storage.ts` — interface + adapter selector.
- `src/lib/effects/storage/adapters/vercelBlob.ts` — production adapter; per-access token routing; env-prefixed pathnames; uses `@vercel/blob` server SDK (`del`, `head`, `issueSignedToken`, `presignUrl`) + `@vercel/blob/client.generateClientTokenFromReadWriteToken`.
- `src/lib/effects/storage/adapters/devLog.ts` — test/dev adapter; stub returns.
- `src/lib/effects/storage/index.ts` — barrel.
- `src/lib/effects/storage/storage.test.ts` — interface contract test against devLog.
- `src/lib/services/file/file.ts`, `errors.ts`, `file.test.ts`, `index.ts` — file metadata service (ADR-0002).
- `src/lib/db/schema/file.ts` — `file` table + `fileAccessEnum`.
- `src/lib/orpc/procedures/image.ts` — `imageRouter` (`mintAvatarUpload`, `confirmAvatarUpload`).
- `src/lib/orpc/procedures/file.ts` — `fileRouter` (`mintDocumentUpload`, `confirmDocumentUpload`, `listDocuments`, `deleteDocument`). *(Since replaced by the `document`/`bin`/`folder`/`documentSearch` routers — ADR-0010.)*
- `src/routes/api/files/download.$id.ts` — auth-gated 302 redirect to a signed Blob URL for private documents. *(Later joined by `view.$id.ts` — same pattern, inline disposition.)*
- `src/components/user/AvatarUpload.tsx` — three-step upload flow against `imageRouter`.
- `src/components/document/DocumentUpload.tsx` — three-step upload flow against `fileRouter`. *(Now lives in `src/components/document/upload/` with the upload-queue components.)*
- `src/components/document/DocumentList.tsx` — shared library with owner-or-admin delete buttons. *(Gone — replaced by the table/card views tree under `src/components/document/` — ADR-0010.)*

**Modified**:
- `src/lib/effects/index.ts` — added `storage` export.
- `src/lib/effects/realtime/types.ts` — added `file.changed` event kind. *(Since replaced by `document.changed` / `folder.changed` / `bin.changed` — ADR-0010.)*
- `src/lib/db/schema/index.ts` — re-exported the `file` table.
- `src/lib/services/user/user.ts` — added `image` to `UserRow` + `userSelection`.
- `src/lib/orpc/router.ts` — mounted `imageRouter` and `fileRouter`.
- `src/routes/_authenticated/documents.tsx` — replaced the placeholder with `<DocumentUpload>` + `<DocumentList>`.
- `src/routes/_authenticated/konto.tsx` — added the `<AvatarUpload>` section *(route since renamed to `account.tsx`)*.
- `src/components/user/UserCard.tsx`, `src/components/contact/ContactCard.tsx`, `src/routes/_authenticated/admin/users.tsx` — render `<AvatarImage src={image}>` when present, falling back to initials.
- `.env.example` — added `BLOB_PUBLIC_READ_WRITE_TOKEN` + `BLOB_PRIVATE_READ_WRITE_TOKEN` + optional `STORAGE_ADAPTER` override.
- `CLAUDE.md` — flipped the "file storage" decision line; added `image.ts` and `file.ts` to the procedures section; added `BLOB_*` to the env section.
- `package.json` — added `@vercel/blob` dependency.
- `drizzle/0003_add_file_table.sql` — migration generated by drizzle-kit.

**Not wired** (called out so future readers know it was considered, then dropped):
- ~~`src/routes/api/files/upload.ts`~~ — the `handleUploadUrl` route from the original plan. Replaced by `image.{mint,confirm}AvatarUpload` + `file.{mint,confirm}DocumentUpload` oRPC procedures.
- ~~`src/lib/imageOpt.ts`~~ — the original `imageOptUrl(src, w, q)` helper was removed; Image Optimization was later re-wired via `src/lib/image/transformer.ts` (`unpic`) instead — see Image Optimization above.

---

## Consequences

**Positive**:
- One provider for compute, DB (via Marketplace integration), and storage. One bill, one dashboard pair, one secret-rotation surface.
- The Vercel Blob SDKs (server `@vercel/blob` + browser `@vercel/blob/client`) collapse the integration to ~150 LOC total across the adapter, the four upload procedures, and the two upload components — compact for what's wired (token minting, signed URLs, two-store routing, env-prefixed pathnames).
- The `effects/storage/` seam keeps the choice reversible — swapping to R2 is bounded to one new file (`adapters/r2.ts`) and a one-line selector change. Procedures and components stay the same.

**Negative**:
- Egress is paid past the included quota. At our scale this is rounding error; at a different scale it would matter.
- Hobby Blob's hard-cap behavior is a real operational hazard for a "this app must work for our co-owners" posture. Mitigated by: (a) quota observability via the Vercel dashboard, (b) email alerts at ~80% usage, (c) the cheap adapter-swap escape hatch documented here.
- Vendor lock-in to the Vercel Blob SDK shape. Acceptable because the `effects/storage/` interface is what consumers depend on, and that interface is backend-neutral by design.

**Revisit triggers** — re-open this ADR (and likely swap to R2) if any of these change:

1. **Blob quota becomes a recurring concern.** If we hit ≥60% of the Hobby Blob quota in two consecutive months, switch — R2's "keep serving, bill you" model is the safer posture.
2. **Documents become broadly shareable.** If the document library ever serves files to non-users (e.g. a public archive, or files shared with third parties via signed URLs), R2's free egress becomes a material cost saving and a peace-of-mind property.
3. **A second provider is added anyway.** If we end up needing R2 for another reason (e.g. a feature that requires S3-compatible APIs), consolidate storage there and retire the Blob adapter — fewer billing surfaces wins.
4. **Vercel Image Optimization pricing changes meaningfully.** The current Hobby tier is comfortable; if it shrinks to where ~20 users could hit it, evaluate Cloudflare Image Resizing (which pairs naturally with R2) as an alternative.
5. **The project leaves Vercel.** If hosting ever moves, R2 + a self-hosted image transformer is the portable shape; do the swap at that point.

The cost of being wrong is bounded: the seam is the whole point. The cost of *not deciding* — leaving R2 as the documented plan while everything else consolidates around Vercel — is more concrete: every new dev needs to learn two backends' setup paths to understand the codebase, and the "wire R2 next" item on the deferred-work list grows stale.
