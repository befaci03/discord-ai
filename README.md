# discord-ai

A Discord bot that lets an AI agent manage your server and Docker containers,
using [TooLang](src/utils/toolang/README.md), a tiny custom language for
writing agent tools in `.tl` files.

## Quick start

```bash
yarn install
cp example.config.toml config.toml   # then edit it
DISCORD_TOKEN=yourtoken yarn dev
```

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

Docs: [TooLang syntax](src/utils/toolang/docs/syntax.md) and
[built-in modules](src/utils/toolang/docs/builtins.md). See
[FEATURES.md](FEATURES.md) for the full feature list.

## Addons: agent capabilities

Addons give the agent itself new powers the LLM calls during conversation:

```toml
[addons]
enabled = ["github", "weather", "tunnel"] # the ONLY list that loads addons

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

A slug that is not in `addons.enabled` is ignored, even when an
`[addons.<slug>]` settings section exists (it is reported as ignored at
startup). Mutating calls are audit-logged. See FEATURES.md for the full list.

Addons can be toggled at runtime from the dashboard, and the toggles are
persisted to `modules/config.json` so they survive restarts.

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
yarn test          # jest suite (src/modules/addons.test.ts covers the addons.enabled gate)
npx tsc --noEmit   # typecheck; `yarn build` runs the same check
```

TypeScript 7 is the native build with no JS compiler API, so jest transpiles
the tests with babel (`jest.config.js`) instead of ts-jest. Type errors stay
`npx tsc`'s job.

## Security

Read [SECURITY.md](SECURITY.md). Short version: the interpreter is jailed
(http allowlists, fs sandbox, no shell, hard execution limits), secrets live
in env vars and are redacted from logs, and everything the agent does is
audit-logged.
