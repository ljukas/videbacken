# Škoda API key

The car's live state (ADR-0022) is read with a MyŠkoda Public API key. Keys expire about every six months; admins see
a warning on /charging from 30 days before, and get emails at 30 and 7 days.

## Create or renew
1. On the phone (MyŠkoda app 8.16+), open https://go.skoda.eu/api-keys. Create a key, select the car, copy it.
2. Vercel → videbacken → Settings → Environment Variables → **Production** only (Preview has its own database but
   would share the car's 20 requests/h): set `SKODA_API_KEY` (on first setup also `SKODA_VIN`, and
   `SKODA_HOME_COORDINATES` = `lat,lon` of the charger). Never commit these.
3. Redeploy production (env changes apply only to new deployments).
4. /charging → "Bilens data" → **Hämta bilens status**. Expect "Bilens status är uppdaterad" and "Nyckeln går ut den …"
   with the new date; the warning disappears.

## Symptoms
- "Škoda: Fungerar inte", auth_failed → the key expired or was revoked: renew. (Emails after 3 failed polls.)
- forbidden → the key doesn't cover the VIN, or `SKODA_VIN` is wrong.
- rate_limited → over 20 requests/h for the VIN (the poll uses 4 requests/h (8 at worst, with gateway retries); local testing with the same key counts): wait an hour.
