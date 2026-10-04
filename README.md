# discord-ai

A Discord bot that lets an AI agent manage your server and Docker containers,
using [TooLang](src/utils/toolang/README.md), a tiny custom language for
writing agent tools in `.tl` files.

## Quick start

```bash
bun install
cp example.config.toml config.toml   # then edit it
DISCORD_TOKEN=yourtoken bun run dev
```

Requires [Bun](https://bun.sh) 1.4.2+: the TypeScript sources run directly,
there is no build step. (Bun 1.3 crashes while loading the mongodb driver's
bson module; 1.4.2 fixed it.)

No `config.toml`? The bot copies `example.config.toml` for you on first run
and tells you to edit it. Secrets should come from the environment: use
`${DISCORD_TOKEN}` style references in the config, or just set the env vars.

## Writing a tool

Drop a `.tl` file in `modules/tools/`:

```tl
{
	"name": "greet",
	"description": "Greets someone",
	"arguments": [
		{ "type": "string", "name": "who", "description": "who to greet", "disallow": [] }
	]
}¤

return("hello {1}".format([args.who]))
```

Call it from Discord: `@bot !greet who=world`

Every **enabled** tool is also handed to the model as a function (the header
arguments become the JSON schema), and listed in its system prompt with those
same arguments as the typed signature, so it knows what it can call instead of
writing its own code. An argument flagged `"optional": true` is not required
and reaches the program as its empty default (`""` / `0` / `false`). Switch a
tool off in the dashboard and it disappears
from both the prompt and the schema, and is refused on the next call.

With `allow_tool_creation = true` (and `allow_skill_creation`) the agent also
gets `manage_tool` / `manage_skill`: it can create, edit and delete its own
`.tl` tools and markdown skills at runtime. Every write is validated with the
real parsers before it touches disk, audit-logged, and `modules/skills/TOOLANG.md`
is protected (that is the language reference, an LLM must not rewrite it).

Docs: [TooLang syntax](src/utils/toolang/docs/syntax.md) and
[built-in modules](src/utils/toolang/docs/builtins.md). See
[FEATURES.md](FEATURES.md) for the full feature list.

## Progress message while tools run

While the agent works through tool calls it posts one message in the channel,
edits that same message on every following call, then deletes it and replies
to your message:

```toml
[general]
# sent on the first call, edited on the next ones, deleted before the answer
execution_message = ":thinking: *Executing `[TOOL_NAME]`...*" # "" = off
```

`[TOOL_NAME]` is replaced with the tool(s) being called. The message never
pings anyone, and a missing permission only means the progress message is
skipped: the answer still lands.

The wording of failures is configurable too (each capped at 500 chars, only
`{error}` / `{service}` are substituted, raw internals never leak):

```toml
[general.errors]
generic = "Something went wrong. The details are in the logs."
tool = "tool error: {error}"
external = ""            # provider outages; "" = use generic
provider = "no LLM provider configured. Set [agent.providers] + [agent.models] ..."
```

## Addons: agent capabilities

Addons give the agent itself new powers the LLM calls during conversation:

```toml
[addons]
enabled = ["github", "weather", "tunnel", "smtp", "cron"] # the ONLY list that loads addons

[addons.github]
default_owner = "befaci03"
allowed_repos = ["befaci03/discord-ai"]   # strongly recommended
allow_repo_creation = true               # create/fork/edit repos, push commits
allow_repo_deletion = false              # delete repos + branches

[addons.tunnel]
allow_route_creation = false             # let the agent manage public routes
allowed_domains = ["example.com", "*.example.com"]

[addons.cron]
allow_job_creation = false               # let the agent schedule jobs
allowed_channels = ["123456789012345678"]
```

- `github`: the agent can manage your account (issues, PR comments, merges,
  stars, branches, releases) and, behind `allow_repo_creation`, create/fork
  repos and **push commits from a unified diff** (`github_apply_diff`: the
  diff is applied to the real file contents, a stale diff is refused, one
  commit, no git binary needed). Deleting anything needs `allow_repo_deletion`.
  Needs `GITHUB_TOKEN` env for writes.
- `weather`: current + forecast, no API key.
- `tunnel`: publishes the dashboard through a Cloudflare Tunnel (public HTTPS
  route, no open port). Needs the `cloudflared` binary; quick mode needs no
  account, named mode reads `CF_TUNNEL_TOKEN` from the environment. The agent
  reads the status, and with `allow_route_creation` can create/edit/remove
  routes (`tunnel_create_route`): local targets only, hostnames only from
  `allowed_domains`, and your own hostname is never editable.
- `smtp`: sends plain-text email through your SMTP relay (nodemailer, pure
  JS). Needs `host` + `from`; TLS is required by default, `allowed_recipients`
  empty = the agent may email anyone (list them, seriously), attachments are
  realpath-jailed to `attachment_dir` (default: `./sandbox`).
- `cron`: scheduled jobs. At the schedule (5-field cron, `@daily`,
  `every 30m`) the agent runs a prompt and posts the answer in a channel.
  Jobs are saved in the database; `allow_job_creation` gates the model's
  add/remove/run-now functions, `allowed_channels` pins where it may post.

A slug that is not in `addons.enabled` is ignored, even when an
`[addons.<slug>]` settings section exists (it is reported as ignored at
startup). Mutating calls are audit-logged. See FEATURES.md for the full list.

Addons can be toggled at runtime from the dashboard, and the toggles are
persisted to `modules/config.json` so they survive restarts.

## Agent brain and personality

The agent keeps a rolling conversation memory and its own tastes, all driven
from the config:

```toml
[agent]
prompt = "You are a helpful Discord agent."
# .prompt.txt in the project root is appended right after this
prompt_file_max_chars = 24000 # cap for .prompt.txt (0 = read the whole file)
tool_rounds = 24              # tool-call rounds per ask (clamp 2..192)
tool_calls_per_round = 10     # tool calls executed per round (clamp 1..15)
max_tokens = 0                # output tokens per call; 0 = provider default (max 5M)

[agent.brain]
memory = 30        # remembered conversation turns (0 = none, clamped to 0..200)
reset = false      # true = forget saved brain state at boot and re-seed below
likes = ["rust"]
dislikes = ["crypto ads"]
favorites = ["shell scripting"]
pending = ["learn japanese"]

[agent.brain.people]
# "123456789012345678" = { description = "server owner", likes = ["football"] }
```

- the lists are only the **starting point**: the model edits its own tastes
  with `brain_set_preference` and keeps profiles with `brain_remember_person`,
  and those edits persist across restarts. With `reset = true` the config wins
  on every startup instead: saved state is wiped at boot, so the agent's own
  edits last until the next restart. Turn it back off to let the brain settle
- memory is bootstrapped from the saved chat history on boot, so conversations
  survive restarts; every exchange is also written to the `chats` table
- on every ask the agent is told who is talking (display name, id, roles,
  elevated permissions) and which permissions **it** has in that channel, so
  it stops promising kicks and embeds it cannot actually send

## Dashboard

A private dashboard ships built-in (config: `[http]`). It shows tool stats,
addon state, the audit trail, and lets you run tools from the browser. Every
loaded tool, skill and addon has an on/off switch (persisted to
`modules/config.json`). Keep `allowed_ips` locked down.

## Writing a skill

Drop a markdown file in `modules/skills/` with TOML frontmatter:

```md
---
name = "my_skill"
description = "What this skill does"
triggers = ["keyword", "/regex pattern/"]
priority = 0
---

Instructions the agent receives when a trigger matches.
```

## Tests

```bash
bun test           # bun's built-in runner: brain, config, tools+docker, dashboard, addons, manage, cron, tunnel, github
bun run typecheck  # tsc --noEmit
```

Tests import from `bun:test` and all live in `src/tests/` (`*.test.ts`).
Bun strips types at run time but never checks them, so type errors stay
`tsc`'s job.

## Security

Read [SECURITY.md](SECURITY.md). Short version: the interpreter is jailed
(http allowlists, fs sandbox, no shell, hard execution limits), docker stays
off unless `[docker].enabled = true` and every op is refused otherwise (when it
is on: published ports bind to `127.0.0.1` unless you set `[docker].bind_address`,
and host mounts need `[docker].allowed_volume_paths` while agent volumes are
jailed in `sandbox/.docker-vols/<volume_id>`), secrets
live in env vars and are redacted from logs, and everything the agent does is
audit-logged.
