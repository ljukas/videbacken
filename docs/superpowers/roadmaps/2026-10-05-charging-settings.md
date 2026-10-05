# Roadmap — charging settings (sources, tariffs, credentials)

Control document for building [the charging settings design](../specs/2026-10-05-charging-settings-design.md)
([ADR-0026](../../adr/0026-integration-credential-store.md)). **One step = one session = one PR.** Each step has
its own self-contained plan, written when the step starts: the previous step's merge changes the files the next one
edits. A step starts only when the previous step's checkpoint has passed.

## Status

| # | Step | Plan | PR | Status | Checkpoint result |
|---|---|---|---|---|---|
| 1 | Settings page: move the tariff card and Datakällor to `/charging/settings` (admin-only), with nav, links and emails | [plan](../plans/2026-10-05-charging-settings-1-move.md) | [#90](https://github.com/ljukas/videbacken/pull/90) | checkpoint passed | 2026-10-05: owner checked the settings page on prod; the member redirect was verified locally |
| 2 | Credential store and resolver (table, crypto, service, per-field resolver, adapters, env docs; no UI) | [plan](../plans/2026-10-05-charging-settings-2-store.md) | [#96](https://github.com/ljukas/videbacken/pull/96) | PR open | — |
| 3 | Credentials UI (dialog per source, grid card, save → sync, remove; copy, runbook) | written when step 3 starts | — | not started | — |

Status values: `not started` → `in progress` → `PR open` → `merged` → `checkpoint passed`.

## Owner prerequisites

- ✅ **Before step 2 merges** (done 2026-10-05): `CREDENTIALS_ENCRYPTION_KEY` (`openssl rand -base64 32`) is set in
  Vercel **Production** (type `sensitive`, never printed or stored elsewhere, so it can't be read back) and a
  separate local key in the main checkout's `.env.local`. Preview gets its own key only if credentials are ever
  stored there; Škoda and Emaldo must never be. Losing the prod key only means re-entering the stored credentials
  (ADR-0026, fail closed).

## How a session runs a step

1. Read this roadmap, the spec and ADR-0026. Find the first step whose status isn't `checkpoint passed`.
   - If it is `merged` but its checkpoint hasn't passed, **run the checkpoint, don't start the next step**. Record
     the result here.
2. Write (or open) that step's plan from the spec. Its first task checks that `main` still matches the spec's
   assumptions.
3. Follow `docs/feature-workflow.md` from **Phase 3 (Isolate)**.
4. In the same PR, update this roadmap's row: PR link and status `PR open`; after merge, `merged`.
5. Stop at the end of the step.

If a step changes a design decision, amend the spec and ADR-0026 in that step's PR.

## Checkpoints (real-world gates)

1. **After step 1 (prod).**
   - As an admin, `/charging/settings` shows the four source tiles, history, the log import and the tariff card.
     The sidebar and Cmd+K show "Inställningar".
   - As a member, the item is hidden and the URL redirects to `/charging`.
   - The overview ends with the session list. Its alerts link to the settings page.
2. **After step 2 (prod).**
   - With the key set and no stored rows, all four sources stay `ok` through one cron cycle of each. Nothing
     changes.
   - A read-only SELECT shows `integration_credential` exists and is empty.
3. **After step 3 (prod).**
   - The owner pastes the current Škoda key in the dialog. The tile shows "Sparad i appen", the post-save sync is
     `ok`, and the key-expiry date is unchanged.
   - "Ta bort sparade uppgifter" drops back to the env var, and the next sync is still `ok`.
   - A read-only SELECT shows only the `v1.` envelope, no plaintext.
