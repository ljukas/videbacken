# Shelly H&T Gen3 webhook setup

How to point a Shelly H&T Gen3 sensor at the climate feature's webhook receiver
(`GET /api/webhooks/shelly`). The device can't send custom headers, so it
authenticates with a shared secret in the query string (`SHELLY_WEBHOOK_TOKEN`).

## The webhook URL

Both the **temperature-change** and **humidity-change** actions on the device
point at the **same** URL. Using `status[...]` placeholders (current values)
rather than `ev.*` (the event that fired) means every webhook carries a full
snapshot, so one row stores both temperature and humidity:

```
<base>/api/webhooks/shelly?token=<SHELLY_WEBHOOK_TOKEN>&mac=${config.sys.device.mac}&t=${status["temperature:0"].tC}&h=${status["humidity:0"].rh}&batt=${status["devicepower:0"].battery.percent}
```

- `<base>` is `http://<LAN-IP>:14600` for the local test, `https://<app-domain>` in production.
- The device URL-encodes interpolated values automatically.
- ~120 chars after substitution — within Shelly's 300-char / 10-hook limit for battery devices.
- Unknown MACs **auto-register** as unnamed devices; name them at `/sensors` (admin only).

## Local (LAN) test — a device next to your machine

1. Ensure `SHELLY_WEBHOOK_TOKEN` is set in `.env` (generate one with
   `openssl rand -base64 32`).
2. Start the dev server bound to the LAN: **`bun run dev:host`**. It prints your
   Mac's LAN IP; Vite's "Network:" line shows the app URL on `:14600`. Approve
   the macOS firewall prompt for `bun`/`node` if asked.
3. Put the Mac and the Shelly on the same Wi-Fi.
4. In the Shelly web UI (open the device's IP in a browser) → **Webhooks /
   Actions**, add **two** webhooks — one on **Temperature change**, one on
   **Humidity change** — both pointing at the URL above with
   `http://<LAN-IP>:14600`. Set a small "minimum interval" while testing.
5. Press the button on the back of the sensor to force a wake → it fires the
   webhook. Watch the dev log for `shelly webhook stored reading`, then reload
   `/sensors` — a tile and chart points should appear.

Quick sanity check without the device (loopback):

```bash
TOKEN=$(grep -E '^SHELLY_WEBHOOK_TOKEN=' .env | cut -d= -f2-)
curl -s -o /dev/null -w '%{http_code}\n' \
  "http://localhost:14600/api/webhooks/shelly?token=${TOKEN}&mac=AABBCCDDEEFF&t=21.4&h=48&batt=90"
# → 204
```

## Production (Vercel) — the permanent under-house sensors

- Set `SHELLY_WEBHOOK_TOKEN` in the Vercel project env (all environments), same
  value the devices use.
- Configure each device with the same URL but `https://<app-domain>`.
- The sensors on home Wi-Fi reach the public HTTPS endpoint directly — no tunnel
  needed.

## Responses & troubleshooting

| Status | Meaning |
|---|---|
| `204` | Stored. |
| `401` | Missing/wrong `token`. |
| `400` | Missing/malformed `mac`, or a value out of range (temp -60..100, humidity 0..100, battery 0..100). |

- The battery placeholder path (`${status["devicepower:0"].battery.percent}`) is
  best-effort — if battery never populates, open the device's live status JSON
  (Shelly UI → device info) and confirm the exact `devicepower:0` battery field,
  then adjust the `batt=` placeholder.
- A battery H&T only wakes on threshold-crossing events (plus periodic wakeups).
  If readings are sparse, lower the change thresholds so it reports more often.
- `t`/`h`/`batt` are each optional — a bare wake (mac only) still records a row
  (with nulls), and an empty value (e.g. `t=`) is treated as absent, not `0`.
