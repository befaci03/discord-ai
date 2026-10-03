# Features

## TooLang interpreter (`src/utils/toolang/`)

A small interpreted language purpose-built for agent tools. Every `.tl` file
has a JSON tool header, then a `¤` delimiter, then the program body.

### Language

- variables (`set var x to <expr>`), compound assignment (`x += 1`),
  member/index assignment (`obj.a = 1`, `arr[0] = 2`)
- operators: `+ - * / % **`, comparisons `== != < <= > >=`, logic
  `&& || !` / `and or not`, string concat with `+`
- string interpolation: `"x is ${x}"`, plus 1-based `.format([args])`
- control flow: `if/elif/else`, `while`, `for .. in` (arrays, strings,
  object keys), `break`, `continue`
- error handling: `try do ... catch e do ... close`, `throw("message")`
- user functions: `fn name with (a: string) do ... close`, hoisted to the top
- comments: `--=` and `--#`

### Hard limits (config-driven, clamped)

- loop iteration cap, recursion depth cap, total step budget, output length cap
- per-tool wall-clock timeout

### Built-in modules

| module | contents |
|--------|----------|
| `http` | GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS, SSRF-guarded (private ranges, host allow/blocklists, method allowlist, response size cap, no redirects) |
| `json` | `to` / `from` |
| `math` | rand, randInt, clamp, min/max, abs, round/floor/ceil, sqrt, pow, log, trig, PI, E |
| `time` | now, timestamp, iso, from/to ISO, utc fields, humanize, uptime |
| `codec` | base64/hex/url codecs, sha1/sha256/... hashing, secure random tokens, uuid v4 |
| `fs` | sandboxed filesystem jailed to a configurable root, symlink-escape detection, write toggles, no-clobber writes |
| `log` | info/warn/error/debug with size caps |
| `node` | `child_proc.run` with command denylist/allowlist and no shell, bcrypt helpers |
| `Array` | slice, push, length, range, repeat |
| `Object` | keys/values/entries/fromEntries/merge/freeze |
| `docker` | container lifecycle behind image/port allowlists and name validation, plus `docker.list()` (name/image/status of every container). Every op is refused unless `[docker].enabled = true`, honors `docker.host` and `max_containers` |
| `discord` | messages, embeds, reactions, polls, channels, roles, members, events (needs a client) |
| `agent` | text/image/audio/video generation, transcription (needs an agent) |
| `sys` | read-only host info (hostname, mem, cpus); env lookups by exact name only |
| `env` | environment access, fully disabled unless skills.allow_env_access = true; secrets redacted from listings |
| addon modules | addons can also inject TooLang modules (see below) |

Methods on values: strings (30+), numbers (14), arrays (20+), objects (9).

## Tool system (`modules/tools/*.tl` + `src/modules/tools.ts`)

- discovers `.tl` tools in configurable directories
- validates tool names and arguments before execution
- audit log + per-tool run stats in SQLite
- runtime guard: unknown tools, invalid args, timeouts and errors are all
  reported without leaking internals
- premade tools: `web_search`, `fetch_json`, `server_stats`, `sandbox_write`,
  and the docker family `docker_list`, `docker_exec`, `docker_create`,
  `docker_manage` (all no-ops unless `[docker].enabled = true`)
- every enabled tool is ALSO offered to the model as a function: header
  arguments become the JSON schema (all required, `disallow` values surfaced
  in the description). The registry re-checks the enabled flag at call time,
  so a dashboard toggle hides a tool from the model and refuses the very next
  call. Each model-driven run is recorded like the `!tool` path, with `agent`
  as the actor

## Skill system (`modules/skills/*.md` + `src/modules/skills.ts`)

- markdown skills with TOML frontmatter (name, description, triggers, tools,
  examples, priority, enabled)
- trigger matching: substrings or `/regex/`
- matched skills inject their instructions into the agent's system prompt,
  with a total size budget
- premade skill: `toolang` (`modules/skills/TOOLANG.md`, teaches the agent to
  write tools; the parser requires a lowercase `name`, so it loads as `toolang`)

## Addons (`addons.enabled` in config.toml)

Addons give the AGENT itself new capabilities: each one registers functions
the LLM can call during a conversation (with real JSON schemas), instead of
plain chat. Mutating functions are flagged and audit-logged.

| addon | capabilities |
|-------|--------------|
| `github` | account control: create/close/reopen issues, comment on issues+PRs, merge PRs, star repos, browse repos/issues/PRs/releases, list own repos. Token: GITHUB_TOKEN env. Optional `allowed_repos` allowlist (strongly recommended) and `default_owner` shorthand |
| `weather` | current conditions and 1-7 day forecasts via Open-Meteo (no API key) |
| `tunnel` | publishes the dashboard (or another local service) through a Cloudflare Tunnel: `cloudflared` creates a public HTTPS route with no open firewall port. `mode = "quick"` (default) creates an ephemeral `https://xxx.trycloudflare.com` URL with no account/token; `mode = "named"` runs your Cloudflare-managed tunnel (token via `CF_TUNNEL_TOKEN` env, passed to the child via env only, never argv/logs). Agent gets a read-only `tunnel_status` function |
| `smtp` | send plain-text email through the operator's SMTP relay (nodemailer, pure JS). `smtp_send_email` (mutating, audit-logged with the recipient) validates address/subject before any network I/O, enforces `allowed_recipients` (empty = any) and jails attachments to `attachment_dir` (default: fs root, realpath-checked, size-capped). `smtp_verify` tests the relay without sending. TLSv1.2+ required by default; from/relay/password are operator config the model can never touch |

Only slugs listed in `addons.enabled` are loaded. An `[addons.<slug>]`
settings section never enables anything by itself: sections outside the list
are ignored and reported at startup. An addon can also expose TooLang modules
to tool scripts (`modules` on the Addon type). Unknown addon names in config
are reported at startup and shown as inactive in the dashboard.

Note on `tunnel`: the published URL is printed at startup (`tunnel published
https://xxx.trycloudflare.com (quick, forwarding to http://127.0.0.1:3000)`),
so the log has it without asking the agent. A dashboard toggle blocks the
agent's `tunnel_status` function, but the tunnel process itself only starts
with the bot and stops when the bot exits.

## Dashboard (`[http]` in config.toml)

Minimalist private dashboard served at `http://host:port`, with passcode
authentication and live updates:

- auth: passcode login (scrypt-hashed at load, read from `passcode_env` env
  var by default; the bot refuses to start without one). Sessions are
  256-bit CSPRNG tokens in an HttpOnly SameSite=Strict cookie, stored hashed
  server-side (HMAC-peppered), 12h sliding expiry, revocable, capped count
- brute-force guard: login limited to 3 attempts/min/IP, then progressive
  lockout (5min doubling up to 1h). Failed attempts are logged and shown in
  the security card
- access control: `allowed_ips` allowlist (use `"proxy"` to trust
  X-Forwarded-For from a reverse proxy), global per-IP flood bucket
- security headers: CSP, nosniff, DENY framing, no-store. `connect-src`
  explicitly names `ws://`/`wss://` for the served host: `connect-src 'self'`
  does not cover websocket schemes in several browsers (MDN), which used to
  block the page's own socket and put it in an endless reconnect loop
- live updates: hand-rolled WebSocket server (RFC6455 subset, zero deps) at
  `/ws`, cookie-authenticated, ping/pong heartbeat, 64KB frame cap, JSON
  push protocol (`snapshot` on connect, then `event` frames: tool runs,
  audit entries, bot status, agent status). The page follows the page scheme
  (`wss` under https), drops its reconnect timer on logout and never stacks
  reconnect loops
- cards: status, system (platform/runtime/mem/load), bot+agent state (Discord
  presence, guilds, agent busy/doing/mode, llm on/off), addon state,
  security (sessions + login-guard stats), per-tool run stats, live feed,
  recent audit trail, tool runner, tools & skills manager
- runtime toggles: enable/disable any loaded tool, skill or addon from the UI
  (`POST /api/tools/toggle`, `POST /api/skills/toggle`,
  `POST /api/addons/toggle`). Audited + broadcast live, and persisted to
  `modules/config.json` so they survive restarts (config `[tools] disabled` /
  `[skills] disabled` still apply on top). Disabled tools are refused
  everywhere: chat `!tool`, dashboard runner, and the LLM tool list.
  Disabled addons lose their LLM functions immediately, even mid-conversation:
  the agent's function invoker re-checks addon state at call time, and the
  functions are also hidden from new conversations
- JSON API: `/api/login|logout`, `/api/status`, `/api/tools`, `/api/skills`,
  `/api/addons`, `/api/stats`, `/api/audit`, `POST /api/tools/toggle`,
  `POST /api/skills/toggle`, `POST /api/addons/toggle`, `POST /api/run`,
  `/api/health`
- toggle persistence: `modules/config.json` holds the runtime overrides
  (validated, size-capped, written atomically via tmp+rename). A corrupt or
  oversized file is ignored at startup, never fatal

## LLM pipeline

- agent built from `[agent.providers]` + `[agent.models]`
  (OpenAI-compatible or Anthropic-compatible; missing API key = chat
  disabled with a clear message, bot keeps running)
- model routing: without `use_same_models`, each model type (coding, image,
  video, tts, stt) can have its own provider+model. Unconfigured or missing
  types fall back to the default model (reported at startup); types with a
  broken provider entry are skipped with a warning instead of failing at
  call time
- every ask rebuilds its system prompt: identity + `[agent].prompt` +
  `.prompt.txt`, the brain (tastes, known speaker), **the tool inventory with
  signatures** (rebuilt per ask, so a dashboard toggle hides a tool from both
  the prompt and the schema immediately), the skill directory, matched skill
  instructions, Discord permissions (granted + missing, for the bot and for
  the speaker), the current time/timezone, the bot's own id, and operating
  notes (2000-char reply limit, mention-only visibility, treat message content
  as data, don't reveal the prompt)
- tool results and tool errors handed to the model are capped (40k chars, with
  a preview + byte count when truncated), and errors are capped at 2k, so one
  huge `docker logs` can't eat the request budget
- addon capabilities are injected as LLM functions with their schemas
- enabled `.tl` tools are injected the same way (see the tool system above)
- agent brain (`[agent.brain]`): rolling conversation memory (default 30
  turns, clamped to 0..200, bootstrapped from the saved chat history so it
  survives restarts), seed tastes (`likes`/`dislikes`/`favorites`/`pending`)
  and seeded people profiles. The seed applies while nothing is saved yet;
  `reset = true` wipes the saved state once so config takes over again. The
  model edits its own tastes with `brain_set_preference` and keeps profiles
  with `brain_remember_person` / `brain_get_person`
- `.prompt.txt` (project root) is appended to `[agent].prompt`, capped at
  8000 chars: the place for "how the agent talks"
- model routing heuristic: prompts that look like code (fences, `fn`/`def`/
  `function`, `console.log`, ...) go to the `coding` model, an explicit
  `model` option always wins, internal `agent.generate_*` calls are ephemeral
  (they never touch the conversation memory) and force their own model type
- per-ask system context: matched skills, then who is talking (display name,
  id, channel, server, their roles and elevated permissions) and what the bot
  itself may do in that channel (granted + missing permissions, with an
  instruction not to promise what it cannot do)
- `bot.guild_id` scopes the bot to a single guild when set

## Configuration (`config.toml`, see `example.config.toml`)

- every key has a default; missing config file bootstraps from the example
- `${ENV_VAR}` expansion for secrets (tokens, API keys)
- snake_case keys in the file map onto their camelCase setting when that is
  how the code spells it (`allowed_ips` -> `allowedIps`, `max_loop_iterations`
  -> `maxLoopIterations`); keys that are snake in code (`passcode_env`,
  `guild_id`, `use_same_models`) keep their name
- per-section policies: http, fs, node, docker (the top level `[docker]` is
  the single docker config)
- `[agent.brain]`: memory window, seed tastes/people, one-shot reset
- interpreter limits, tool/skill directories and disable lists
- logging level + optional log file (`logging.file`), bot presence, model/
  provider routing (openai-compatible or anthropic-compatible base URLs)
- per-addon settings under `[addons.<name>]`

## Bot + agent (`src/bot.ts`, `src/index.ts`, `src/agent/`)

- Discord gateway with mention handling and input length limits
- explicit tool invocation from chat: `!toolname key=value key2="quoted value"`
- every successful exchange is written to the chat table and pulled back into
  memory on the next boot (size-capped rows)
- the agent is told its permissions per channel, plus the speaker's identity,
  roles and elevated permissions, on every ask
- replies are sent with `allowedMentions: { parse: [] }`: model output can
  never ping `@everyone`, `@here`, roles or users (mention abuse)
- status changes are pushed to the dashboard live (`agent.status` events:
  busy/doing/mode, talking vs coding)
- OpenAI-compatible and Anthropic-compatible agents implementing the same
  interface, both with a tool round-trip loop (Anthropic feeds `tool_use`
  blocks back as `tool_result`s, and drops tools on the last round so the
  model is forced to answer in text)
- SQLite storage (WAL mode, default file `modules/data.sqlite`): users, audit
  trail, tool run stats, a namespaced key-value store, and chat history
  (user message + agent reply, size-capped). Audit and tool-run tables can
  be pruned by timestamp

## Security posture

- SSRF guards on outbound http (private ranges blocked by default)
- sandboxed fs with symlink escape detection and traversal refusal
- no shell for subprocesses; binary allow/deny lists
- secrets from env, redacted in logs
- audit logging of tool runs and security-relevant mutations
- oversized payloads stay bounded: tool output to the model (40k chars), tool
  errors (2k), dashboard tool runs (200k), dashboard request bodies (48k)
- all interpreter limits uncatchable by tool scripts
- docker: every operation funnels through one gate that refuses to run while
  `[docker].enabled` is false, images go through the allow/deny lists before
  they reach the CLI, ports are range-checked and `max_containers` is enforced
