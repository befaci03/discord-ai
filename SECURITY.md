# Security Policy

## Security Practices

- Keep dependencies up to date *except `discord.js` **if not a security update***; review dependency changes for security fixes. Installs run through `bun install` with `bun.lock` as the single lockfile (`yarn.lock` was removed). Install-time lifecycle scripts are blocked by default; the one deliberate exception is `trustedDependencies: ["bcrypt"]`, whose `node-gyp-build` script picks the shipped prebuilt binary (compiling from source only as a fallback).
- Avoid storing secrets in the repository; use environment variables or secret management.
- Addons load only when their slug is listed in `addons.enabled`; an
  `[addons.<slug>]` settings section alone never activates code, and ignored
  sections are reported at startup.
- SMTP addon: the model only supplies to/subject/body/attachments; the sender
  identity, relay and every other header are operator config. Addresses and
  subjects are validated before any network I/O (no CR/LF: no header
  injection), recipients go through `allowed_recipients` (empty = any address,
  an operator choice the startup note calls out), and attachments are
  realpath-jailed to `attachment_dir` with size caps, read into memory so the
  transport never touches the filesystem itself. TLS is required by default
  (TLSv1.2+), the password never appears in logs, responses or errors, sends
  are audit-logged with the recipient only (never the body), and the
  function description carries prompt-level guardrails (send only what the
  user asked for, to whom they said).
- Cloudflare Tunnel addon: `cloudflared` is spawned without a shell (argument
  array, no `sh -c`), the named-mode tunnel token travels via the child's
  environment only (never `argv`, logs or API responses; output is redacted as
  a fallback) and the child is killed when the process exits. Publishing the
  dashboard routes traffic in from localhost, which makes `allowed_ips` a
  non-barrier: the passcode plus the login rate limiter are the real defense,
  so keep a strong `DASHBOARD_PASSCODE` and set `DASHBOARD_SECRET`.
- Mention abuse: every reply leaves the bot with `allowedMentions` limited to
  `parse: []`, so model output (which can be steered by a prompt injection)
  can never ping `@everyone`, `@here`, a role or a user, and the per-ask
  context tells the model which permissions it actually has instead of
  letting it promise moderation actions it cannot perform.
- Docker: every `docker.*` operation funnels through a single gate that
  refuses to run while `[docker].enabled = false` (it used to be read and
  never enforced). Images from the caller pass the allow/deny lists before
  they reach the CLI (including `create`, which previously skipped them),
  ports are range-checked against `allowed_ports`, `max_containers` is
  enforced before a create, container/image names are pattern-validated,
  and commands run from an argv array with no shell. While docker is off the
  `docker_*` tools are not even offered to the model; if they do get called
  (`!docker_list`), they fail with an explicit "docker is disabled" error
  instead of a silent no-op.
