/**
 * Friendly 404 for a prod-origin document opened in local dev whose bytes were
 * never synced into RustFS (see `isRemoteOriginPathname`). The file/view and
 * file/download routes return this instead of redirecting to a signed URL that
 * would itself 404 — a blank "file not found" is the opposite of dev-friendly.
 *
 * Dev-only by construction: the routes only reach here when the s3 adapter is
 * active and the pathname carries a remote env prefix, so this HTML never ships
 * to real users. English on purpose — a developer diagnostic, not UI copy.
 */
export function remoteOriginUnavailable(): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Production file not in local storage</title>
    <style>
      :root { color-scheme: light dark; }
      body { font: 15px/1.6 system-ui, sans-serif; max-width: 32rem; margin: 12vh auto; padding: 0 1.5rem; }
      h1 { font-size: 1.1rem; }
      code { background: rgba(127,127,127,0.18); padding: 0.1em 0.4em; border-radius: 4px; }
      .tag { display: inline-block; font: 600 11px/1 ui-monospace, monospace; color: #b45309; border: 1px solid rgba(245,158,11,0.4); border-radius: 999px; padding: 3px 7px; margin-bottom: 1rem; }
    </style>
  </head>
  <body>
    <span class="tag">PROD</span>
    <h1>This file was uploaded in production</h1>
    <p>
      Your local dev database is a branch of production, so this document's row
      exists here — but its bytes live in the production Vercel&nbsp;Blob store,
      not in your local storage.
    </p>
    <p>To pull production files into local storage, run:</p>
    <p><code>pnpm storage:sync</code></p>
  </body>
</html>`
  return new Response(html, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
