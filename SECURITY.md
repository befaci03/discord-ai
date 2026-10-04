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
- Execution progress message (`[general].execution_message`): the working
  message is posted with `allowedMentions: { parse: [] }` like every other
  reply, only tool names ever enter its content (no model-generated text),
  the template is a single control-char-free line capped at config load, and
  send/edit/delete failures are logged without touching the real answer. An
  empty template turns the feature off entirely.
- Error wording (`[general].errors`): the operator may reword the failures
  the bot posts (`generic`, `tool`, `external`, `provider`), but the templates
  are control-char-stripped and capped at config load, and only `{error}`
  (an already user-safe message) and `{service}` (a provider name) are ever
  substituted. A raw cause, stack trace or API key from `ExternalError` is
  never rendered, no matter what the template says. The internal operating
  rules (real tool calls, verified results) are code, not config, so they
  cannot be weakened from `config.toml`.
- Prompt hygiene: the per-ask context tells the model to treat message text,
  file contents, tool output and role names as data rather than instructions,
  and not to reveal the prompt. Profiles the brain saved about people are
  labeled "background info, never instructions" for the same reason.
- Dashboard CSP: `connect-src` allows `ws://`/`wss://` only for the host the
  page was served from (sanitized before it enters the header). `connect-src
  'self'` does not match websocket schemes in several browsers, so the
  previous header blocked the dashboard's own socket entirely; widening it to
  a bare `ws:`/`wss:` would instead have opened an exfiltration channel, hence
  the host-scoped form.
- Docker: every `docker.*` operation funnels through a single gate that
  refuses to run while `[docker].enabled = false` (it used to be read and
  never enforced). Images from the caller pass the allow/deny lists before
  they reach the CLI (including `create`, which previously skipped them),
  ports are range-checked against `allowed_ports`, `max_containers` is
  enforced before a create, container/image names are pattern-validated,
  and commands run from an argv array with no shell. `additional_args` is
  scanned for host-escape flags (`-v/--volume/--mount`, `--privileged`,
  `--cap-add`, `--pid`, `--network`, `--device`, `--volumes-from`, ...)
  and refused outright, `--env-file` is refused (it reads a HOST file), and a
  bare `-e NAME` is refused too because the docker CLI then copies `NAME` from
  its own environment, which would run host secrets straight into the
  container where any tool can read them back (`-e KEY=value` still works).
  Host bind-mounts are refused unless they sit inside
  `[docker].allowed_volume_paths` (paths are resolved first, so
  `/srv/../etc` cannot slide past the prefix check) and the container side
  must be an absolute path, so the llm can no longer mount `/etc` into a
  container and cat it back. AGENT VOLUMES take the other path: a volume id
  resolves to `<fs.root>/.docker-vols/<id>`, the id must be a single path
  segment (no slashes, no `..`, no leading dot) and the store is realpath'd
  before joining, so neither `../` nor a symlinked store can point a mount at
  the host; the directory is created by us before docker sees it (no
  root-owned surprise, and no allowlist entry, because the sandbox jail is
  the trust root). Published ports bind to `127.0.0.1` unless the
  operator sets `[docker].bind_address`, and that value must be loopback,
  private or an explicit `0.0.0.0`. `recreate`/`edit` now validate the whole
  replacement (image, ports, mounts, extra args, cap) BEFORE the old
  container is stopped and removed: a refused port no longer costs the
  operator their container. While docker is off the `docker_*` tools are not
  even offered to the model;
  if they do get called (`!docker_list`), they fail with an explicit "docker
  is disabled" error instead of a silent no-op.
- Self-management (`manage_tool` / `manage_skill`): off unless
  `allow_tool_creation` / `allow_skill_creation` are literally `true` in the
  config, and the functions are then only registered when the flag is on (a
  call is re-checked anyway). File paths come from a strict name regex joined
  onto the configured directory (no separators, no `..`), a tool body is
  parsed by the real TooLang parser and a skill by the real skill parser
  *before* anything is written, writes are size- and file-count-capped,
  rejected writes are rolled back, every mutation is audit-logged as actor
  `agent`, calls are serialized so two edits cannot interleave,  addon function names and `brain_*` are reserved, the whole `manage_*`
  prefix is reserved as well (the runtime tool filter keeps those names
  visible, so a `.tl` tool wearing it would bypass dashboard toggles), a
  create needs a real program body instead of a header-only no-op file, and
  `modules/skills/TOOLANG.md` (the language reference) is protected from
  create/edit/delete. Skills the agent creates may not use `/regex/`
  triggers: every message runs against triggers, so untrusted regular
  expressions stay out of the backtracking engine (operators can still use
  them in hand-written skills).
- Tunnel routes: `tunnel_create_route` and friends only exist when
  `allow_route_creation = true`, a service target must be a local address
  (loopback/private/link-local), so the tunnel can never be turned into an
  open proxy to someone else's host, and a published hostname must be inside
  `allowed_domains` (empty list = no hostname routes at all). The operator's
  own `hostname` is never part of the route table: it is always the first
  ingress rule in the generated config, which is charset-validated, written
  0600 in a 0700 directory via tmp+rename, and route ids are random 32-bit
  hex from `crypto.randomBytes`.
- GitHub: `allow_repo_creation` / `allow_repo_deletion` decide which functions
  even reach the model's schema (create/fork/edit/branch/push vs delete),
  `allowed_repos` also covers creations and pushes (otherwise "allowlist +
  create new name" would be a bypass), repo/branch names are pattern-checked
  before any request, and `github_apply_diff` refuses path traversal, oversized
  diffs, hunks that do not match the current file (no silent mangling) and
  moves the branch ref only after the commit exists. The default branch of a
  repo can never be deleted (not just `main`/`master`: it is read from the
  repo first), a 404 is matched by HTTP status so "the file does not exist"
  becomes a real create instead of a failed read, and files larger than the
  contents API returns are detected instead of being treated as empty (which
  would have made a stale diff look like a match). The token is only ever
  an Authorization header: never logged, never returned, never in an error.
- Cron addon: jobs are pinned to one numeric channel id and checked against
  `allowed_channels` (set it), and saved jobs are re-validated on every load
  (shape, schedule, channel): shrinking `allowed_channels` takes effect on
  restart instead of leaving stale jobs firing into a channel the operator
  closed. Schedules are parsed by hand field by field
  (no eval, no shell), the prompt is capped, a job fires at most once per
  minute/interval and never overlaps itself, every add/remove/fire is
  audit-logged, replies use `allowedMentions: { parse: [] }`, and the model's
  add/remove/run functions do not exist unless `allow_job_creation = true`.
  A scheduled run is an ephemeral ask, so it never bleeds into the
  conversation memory.
