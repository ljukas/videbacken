# Škoda API key

The car's live state (ADR-0022) is read with a MyŠkoda Public API key. Keys expire about every six months; admins see
a warning on /charging from 30 days before, and get emails at 30 and 7 days.

## Create or renew
1. On the phone (MyŠkoda app 8.16+), open https://go.skoda.eu/api-keys. Create a key, select the car, copy it.
2. Laddning → Inställningar → the key button on the Škoda tile → paste it into "API-nyckel" (VIN and position only on
   first setup) → **Spara**. The Škoda sync runs at once: expect "Fungerar" and "Nyckeln går ut den …" with the new
   date; the warning disappears. If the sync fails right away, wait a minute and press **Synka nu**: another warm
   instance may hold the old stored values for up to 60 s (ADR-0026).

**Fallback** (no `CREDENTIALS_ENCRYPTION_KEY`, or the app is down): set the env vars in Vercel → videbacken → Settings →
Environment Variables → **Production** only (Preview has its own database but would share the car's 20 requests/h):
`SKODA_API_KEY` (on first setup also `SKODA_VIN`, and `SKODA_HOME_COORDINATES` = `lat,lon` of the charger). Never commit
these. Redeploy production (env changes apply only to new deployments), then Laddning → Inställningar → the Škoda tile →
**Synka nu**. A stored value overrides its env var field by field: while a row is stored, an env change does nothing
until the row is removed ("Ta bort sparade uppgifter", which needs the app). That clears **every** stored Škoda field,
so env must then hold the VIN and home coordinates too, not just the key.

## Symptoms
- "Škoda: Fungerar inte", auth_failed → the key expired or was revoked: renew. (Emails after 3 failed polls.)
- `credentials_unreadable` → the encryption key (`CREDENTIALS_ENCRYPTION_KEY`) is missing or changed: restore it, or
  set a new key and re-enter every field.
- forbidden → the key doesn't cover the VIN or the VIN is wrong; the tile names the field (VIN, or key + VIN).
- rate_limited → over 20 requests/h for the VIN: wait an hour. The poll uses 4 requests/h, 8 at worst with gateway retries, and local testing with the same key counts too.
