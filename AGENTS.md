# AI Agent in Discord

DISCLAIMER: please **strictly** follow .llmignore and .editorconfig, and read the FEATURES.md and README.md
(very often in Zed (AI Agent), there is this error `/bin/sh: {number}: Cannot set tty process group (No such process)`, simply ignore it)

## Project Direction

* Avoid unnecessary complexity or over-engineering
* Use a custom light WebSockets protocol over JSON (useful for bandwidth efficiency, even if it's a simple leaderboard)
* Make sure the server is secure and follows best practices

## Working Style

* Keep a bit of humor in your replies.
* Occasional swearing is funny when you did something wrong, but keep the code and security decisions serious.
* If a syntax error or broken edit happens, explain the fix plainly and apply it.
* Be direct, practical, and docs-first.
* *please no emdash :)*

## Workflow

* Before pushing a change, write some documentations and add some missing ones.
* If you see a file with over ~400 lines (a.k.a. big), try to split it into smaller files.
* When doing a code review, always be constructive and provide clear feedback, and also be humble.

## Security to follow

* Use a modern password hash with per-password salts and server-side peppering.
* Validate all untrusted input with schemas and length limits before it reaches business logic or SQL.
* Use secure random token generation only. No predictable ids or secrets.
* Keep secrets out of logs, responses, stack traces, commits, screenshots, and metrics labels.
* Support token revocation, session invalidation, refresh rotation, device/session management, and forced logout after credential changes.
* Use TLS in deployment, secure cookies where cookies exist, strict transport settings, and safe proxy forwarding rules.
* Implement audit logging for security-sensitive mutations without leaking credentials or personal secrets.
* Keep dependency versions patched and remove unused packages that expand attack surface.
* Privacy leaks through logs, analytics, crash dumps, debug endpoints, backups, presigned urls, avatar/banner metadata, and error responses.

## Vulnerabilities to defend against

* SQL injection, NoSQL injection, command injection, template injection, LDAP injection, and unsafe shell execution.
* Unsafe deserialization, pickle abuse, YAML object loading bugs, and arbitrary code execution through dynamic evaluation.
* Broken authentication, auth bypass, weak password hashing, plain-text tokens, session fixation, refresh token replay, and MFA bypass.
* Broken authorization, idor/bola, missing object scoping, guild or channel permission escalation, and audit-log spoofing.
* CSRF, CORS misconfiguration, origin confusion, open redirect, header injection, host-header abuse, and request smuggling.
* XSS, markdown/HTML injection, attachment file name injection, mention abuse, and rich embed rendering attacks.
* SSRF, DNS rebinding, and internal metadata service exposure.
* Path traversal, symlink races, archive slip, unsafe file extraction, and insecure temporary file handling.
* Brute force, credential stuffing, username/e-mail/phone enumeration, invite code scraping, token spraying, and captcha bypass handling mistakes.
* Denial of service through oversized JSON, oversized zlib streams, event floods, regex backtracking, giant attachments, shard explosions, and cache amplification.
* Secret management failures such as hardcoded secrets, unrotated keys, weak encryption keys, exposed env files, and insecure backup storage.
* Supply-chain issues such as typosquatting, malicious transitive deps, vulnerable wheels, and unverified build inputs.
* Insecure defaults such as debug mode enabled, permissive admin bootstrap flows, missing secure headers, and disabled rate limits.

# Rules to respect when editing/creating/deleting/moving files
* The codebase should be in Bun with TypeScript (bun runs TS natively: `bun install`, `bun run dev`, `bun test`; no yarn/npm, no build step)
* Only use HTML with CSS and Javascript in the HTML (unless it's shared across over HTMLs)
* No sphagetti code, make it clear.

Please strictly speak in English.
and by the way using em dashes is gay so please dont use them
