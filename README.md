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
arguments become the JSON schema), so the agent can use it on its own. Switch
a tool off in the dashboard and it disappears from the model's list and is
refused on the next call.

Docs: [TooLang syntax](src/utils/toolang/docs/syntax.md) and
[built-in modules](src/utils/toolang/docs/builtins.md). See
[FEATURES.md](FEATURES.md) for the full feature list.

## Addons: agent capabilities

Addons give the agent itself new powers the LLM calls during conversation:

```toml
[addons]
enabled = ["github", "weather", "tunnel", "smtp"] # the ONLY list that loads addons

[addons.github]
default_owner = "befaci03"
allowed_repos = ["befaci03/discord-ai"]   # strongly recommended
```

- `github`: the agent can manage your account (issues, PR comments, merges,
  stars). Needs `GITHUB_TOKEN` env for writes.
- `weather`: current + forecast, no API key.
- `tunnel`: publishes the dashboard through a Cloudflare Tunnel (public HTTPS
  route, no open port). Needs the `cloudflared` binary; quick mode needs no
  account, named mode reads `CF_TUNNEL_TOKEN` from the environment.
- `smtp`: sends plain-text email through your SMTP relay (nodemailer, pure
  JS). Needs `host` + `from`; TLS is required by default, `allowed_recipients`
  empty = the agent may email anyone (list them, seriously), attachments are
  realpath-jailed to `attachment_dir` (default: `./sandbox`).

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
# .prompt.txt in the project root is appended right after this (max 8000 chars)

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
bun test           # bun's built-in runner: brain, config, tools+docker, dashboard, addons, smtp, sqlite
bun run typecheck  # tsc --noEmit
```

Tests import from `bun:test` and live next to the code as `*.test.ts`.
Bun strips types at run time but never checks them, so type errors stay
`tsc`'s job.

## Security

Read [SECURITY.md](SECURITY.md). Short version: the interpreter is jailed
(http allowlists, fs sandbox, no shell, hard execution limits), docker stays
off unless `[docker].enabled = true` and every op is refused otherwise, secrets
live in env vars and are redacted from logs, and everything the agent does is
audit-logged.
