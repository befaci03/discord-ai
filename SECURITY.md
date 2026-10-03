# Security Policy

## Security Practices

- Keep dependencies up to date *except `discord.js` **if not a security update***; review dependency changes for security fixes.
- Avoid storing secrets in the repository; use environment variables or secret management.
- Addons load only when their slug is listed in `addons.enabled`; an
  `[addons.<slug>]` settings section alone never activates code, and ignored
  sections are reported at startup.
- Cloudflare Tunnel addon: `cloudflared` is spawned without a shell (argument
  array, no `sh -c`), the named-mode tunnel token travels via the child's
  environment only (never `argv`, logs or API responses; output is redacted as
  a fallback) and the child is killed when the process exits. Publishing the
  dashboard routes traffic in from localhost, which makes `allowed_ips` a
  non-barrier: the passcode plus the login rate limiter are the real defense,
  so keep a strong `DASHBOARD_PASSCODE` and set `DASHBOARD_SECRET`.
