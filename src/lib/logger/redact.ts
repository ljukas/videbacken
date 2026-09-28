// Conservative redaction policy: scrub auth/session headers if anyone ever logs
// a request or headers object. PII (user ids, admin emails) is fine to log —
// this is an internal 10-20-user app. Magic-link URLs are not redacted here:
// the devLog adapter (their only emitter) redacts them itself in production
// (ADR-0008), and a global `url` path would scrub far too much.

export const serverRedactPaths = [
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  '*.headers.authorization',
  '*.headers.cookie',
  'request.headers.authorization',
  'request.headers.cookie',
  // Credentials of outbound integrations (e.g. the Zaptec password grant). A
  // backstop only — adapters must not log credentials or token responses at all.
  'password',
  '*.password',
  'access_token',
  '*.access_token',
  'refresh_token',
  '*.refresh_token',
]
