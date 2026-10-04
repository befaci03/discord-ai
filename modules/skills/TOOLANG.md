---
name = "toolang"
description = "TooLang reference: lexer/parser tokens, builtin catalog with signatures, security and permission model, CLI training and lint modes, runtime debug interface and glossary for the .tl tool language"
triggers = ["toolang", "too lang", ".tl file"]
priority = 0
---

# TOOLANG reference — continued

This is the second half of the TOOLANG skill. It covers the operational details:
how a tool is loaded and executed, how the interpreter consumes a program,
the complete builtin catalog with signatures, the security and permission model,
the CLI training / lint modes, a runtime trace and debug interface, a
migration cheat sheet, a conformance test table, and a glossary. Read the first
half (sections 0-12) for the syntax; this half for the machinery around it.

---

## 13. Parser and token stream

### 13.1. Lexer tokens

The lexer turns raw source into a flat token stream. Token types are:

```
LBrace  "{"
RBrace  "}"
LBracket "["
RBracket "]"
String  "..." (double-quoted JSON-ish string)
Number  123 / 3.14 / -7
True    true
False   false
Null    null
Undefined  undefined
Colon   ":"
Comma   ","
Semicolon ";"
Equals  "="
Incr    "++"
Decr    "--"
Plus    "+"
Minus   "-"
Star    "*"
Slash   "/"
Percent "%"
Caret   "**"
Lt      "<"
Gt      ">"
Le      "<="
Ge      ">="
Eq      "=="
Ne      "!="
And     "&&"
Or      "||"
Not     "!"
Assign  "="
AssignAdd "+="
AssignSub "-="
AssignMul "*="
AssignDiv "/="
AssignMod "%="
Dot     "."
LBracketBracket "[["
RBracketBracket "]]"
ToolDelim "¤"
If      "if"
Elif    "elif"
Else    "else"
While   "while"
For     "for"
In      "in"
Do      "do"
Close   "close"
Return  "return"
Fn      "fn"
Call    "call"
Try     "try"
Catch   "catch"
Throw   "throw"
Break   "break"
Continue  "continue"
SetVar  "set"
Var     "var"
Identifier (identifier)
Comment  (--)
Eof
```

Tokens carry `line` and `col` so parser errors can point at the right place.

### 13.2. Parsing phases

1. `parseToolSource(source)` — the recommended entry point for a tool file.
   It strips the header (up to the `¤` delimiter), validates the JSON, and
   returns a `ParsedTool { header, body }`.
2. `parseToolFile(filePath)` — like `parseToolSource` but reads the file from
   disk, then parses.
3. `parseBody(tokens)` / `parseProgram(tokens)` — parses the body after the
   delimiter into a `Program { header, body: Statement[] }`.

`parseToolSource` is what the tool registry uses when loading `*.tl` files.
Always use it when you write a validator or a loader; do not hand-parse JSON in
tool code.

### 13.3. Grammar (deterministic)

```
program       = header? TOOLDELIM body
header        = JSONText
body          = statement*
statement     = varDecl | fnDef | callStmt | returnStmt | ifStmt
              | whileStmt | forStmt | tryStmt | throwStmt | breakStmt
              | continueStmt | exprStmt | empty

varDecl       = SET VAR name TO expr
fnDef         = FN name LPAREN params RPAREN DO block CLOSE
callStmt      = CALL expr ( args )? 
returnStmt    = RETURN expr?
ifStmt        = IF expr THEN block (ELIF expr THEN block)* [ELSE block] CLOSE
whileStmt     = WHILE expr DO block CLOSE
forStmt       = FOR varName IN expr DO block CLOSE
tryStmt       = TRY DO block (CATCH identifier DO block)? CLOSE
throwStmt     = THROW expr
breakStmt     = BREAK
continueStmt  = CONTINUE
exprStmt      = expr SEMICOLON?

block         = DO statement* CLOSE

expr          = assignment
assignment    = target ( ASSIGN | ASSIGN_ADD | ... ) expr | binary
binary        = logical ( (AND | OR) logical )?
logical       = equality ( (AND) | (OR) | (NOT) )?
equality      = comparison ( (== | !=) comparison )?
comparison    = term ( (LT | GT | LE | GE) term )?
term          = factor ( (PLUS | MINUS) factor )*
factor        = power ( (STAR | SLASH | PERCENT) factor )*
power         = unary ( (CARET) unary )?
unary         = (NOT | MINUS) unary | call
call          = member ( LPAREN args? RPAREN )?
member        = primary ( DOT identifier | LBRACKET expr RBRACKET )*
primary       = literal | identifier | template | object | array
```

Operator precedence (lowest → highest): `||`, `&&`, `==`, `!=`, `<`, `<=`,
`>`, `>=`, `+`, `-`, `*`, `/`, `%`, `**` (right-associative), unary `-`, `!`,
`()`/`[]`/`.`/function call.

### 13.4. Semicolons

Semicolons are optional. `return x` and `return x ;` are identical. The parser
accepts a trailing semicolon after any expression statement. Multi-statement
lines are allowed only with explicit semicolons:

```tl
set var a to 1; set var b to 2   -- INVALID without semicolons
set var a to 1; set var b to 2   -- VALID
```

### 13.5. Comments

`--= this is a comment` to end of line. `--` (without `=`) is also accepted for
backwards compat. Comments do not nest.

---

## 14. Interpreter state machine

### 14.1. The interpreter object

`Evaluator` holds:
* `vars` — `Map<string, unknown>`; the dynamic scope of the current tool body.
* `fns` — `Map<string, FnDef>`; hoisted top-level function definitions.
* `ctx` — `InterpreterContext` (config, sandbox, limits, extraVars, logger).
* `steps` — a monotonic counter throttled by `limits.maxSteps`.
* `callDepth` / `loopDepth` — recursion and loop nesting guards.
* `returnSignal` — a one-shot signal for the first (outermost) `return`.

### 14.2. Execution model

`run(program, args)`:
1. Seed `vars["args"]` with the incoming arguments.
2. Copy `ctx.extraVars` into `vars` (addon modules are visible here).
3. Hoist all `fn` statements into `fns` so calls can resolve before the
   definition line.
4. `execBlock(program.body)` — execute each statement in order.
5. Return `returnSignal.value` if a `return` fired, else `null`.

`execStmt` switches on statement kind. `execBlock` runs a list of statements
and returns the first non-`undefined` control-flow result (`RETURN` /
`BREAK` / `CONTINUE`); plain `undefined` falls off the end.

### 14.3. Scope save/restore for calls

When a function call is in progress, the interpreter snapshots the current
`vars` map. If the call throws a `RuntimeError`, the snapshot is restored so the
tool body is left in a consistent state. This is why `set var x to f()` is not
done as `this.vars.set(name, await this.evalExpr(...))` directly — the await
could swap the map and write to a stale reference.

### 14.4. Limits

Each `InterpreterLimits` instance carries:
* `maxSteps` — default 200_000. Each expression and statement ticks a counter.
* `maxLoopIterations` — default 10_000. Each `while`/`for` iteration counts.
* `maxCallDepth` — default 64. Decremented per function call; throws at 0.
* `maxOutputLength` — default 100_000. Enforced by the caller that receives the
  final result, not inside the interpreter.

Milestones that throw:
* `RuntimeError("execution budget exceeded (N steps), this tool is going to the shadow realm")`
* `RuntimeError("call depth exceeded (N)")`
* `RuntimeError("loop iteration budget exceeded (N)")` — prefix contains
  `"exceeded"` so a catch-all can distinguish them from ordinary errors.

### 14.5. The `this` / context argument

Inside a tool, the only implicit value is `args`. There is no `this`. If a
function needs context, thread it explicitly as a parameter:

```tl
fn logNow(ctx) do
  log.info("scope", ctx.scope)
close

call(logNow, { scope: "tool" })
```

Never reach for closure variables from the enclosing file — a tool file is a
function, not a class.

---

## 15. Errors

### 15.1. Error classes

| class | thrown by | catchable |
|-------|-----------|-----------|
| `TooLangError` | `throw(...)` | yes |
| `RuntimeError` | limits, invalid ops, unknown identifier | yes (except budget) |
| `ParseError` | syntax errors | no |

### 15.2. When `catch` can and cannot catch

The `try ... catch` machinery catches `RuntimeError` instances whose message
**does not** contain `"exceeded"` or `"budget"`. This means:

```tl
try do
  set var x to 0
  while true do
    set var x to x + 1
  close
catch e do
  return("caught: " + e)   -- this block is NEVER reached
close
```

Budget errors unwind the stack regardless of `try/catch`. This is deliberate:
a tool that exceeds its iteration or step budget is dangerous and must abort.

### 15.3. Error propagation

* A `throw` inside a function propagates up through the call stack; if it
  reaches `execBlock` of the tool body, the body aborts with that error.
* A `RuntimeError` with `"exceeded"`/`"budget"` propagates out of `run()`.
* An ordinary `RuntimeError` is caught by a matching `catch`.

### 15.4. Providing structured errors

Throw a JSON object for structured errors; the message string is what the LLM
and user see:

```tl
throw({ code: "NOT_FOUND", field: "id", value: args.id })
```

Clients of the tool can read `e` and inspect the JSON text.

---

## 16. Builtins — full catalog

### 16.1. Conventions

* Module names are global properties: `http.get(url)`, `fs.read(path)`.
* Methods are invoked on values: `arr.slice(1, 3)`, `obj.keys()`.
* All builtin functions are **async** from the interpreter's point of view when
  they touch the outside world (network, file system, crypto, time). Pure
  computations are synchronous.
* Values returned across the host/tool boundary are coerced with `String()` or
  preserved as `number`/`boolean`/`object`/`array`/`null`.

### 16.2. `http`

```tl
http.get(url: string) -> { status: number, response: string, headers: object }
http.post(url, body?) -> same
http.put(url, body?)
http.patch(url, body?)
http.delete(url)
http.head(url)
http.options(url)
```

The response body is a string. To get structured JSON, pipe into
`json.to()` or parse manually with `json.to`. Private-IP hostnames are blocked
by default unless `http.allowedHosts` or `http.blockPrivate` is configured.

### 16.3. `json`
```tl
json.to(text: string) -> object
json.from(obj: object) -> string
```

### 16.4. `math`
```tl
math.rand(min?, max?)        -- number in [min, max)
math.randInt(min, max)       -- integer
math.clamp(v, lo, hi)        -- number
math.max(...nums)            -- number
math.min(...nums)            -- number
math.abs(n)                  -- number
math.round(n)                -- number
math.floor(n)                -- number
math.ceil(n)                 -- number
math.sqrt(n)                 -- number
math.pow(base, exp)          -- number
math.log(n)                  -- number
math.sin/cos/tan/n            -- number (radians)
math.atan2(y, x)             -- number
math.PI, math.E              -- number
```

### 16.5. `time`
```tl
time.now()            -- epoch ms
time.timestamp()      -- epoch seconds (float)
time.iso()            -- current ISO 8601
time.fromIso(str)     -- epoch ms
time.toIso(ms)        -- ISO string
time.year(ms?)       -- UTC year
time.month(ms?)       -- 1–12
time.day(ms?)         -- 1–31
time.hour(ms?)        -- 0–23
time.minute(ms?)
time.second(ms?)
time.weekday(ms?)     -- 0 = Sunday
time.humanize(seconds) -- "1h 02m 03s"
time.uptime()         -- process uptime seconds
```

### 16.6. `codec` (cryptographic helpers)
```tl
codec.base64Encode(text)
codec.base64Decode(text)
codec.hexEncode(text)
codec.hexDecode(hex)
codec.urlEncode(text)
codec.urlDecode(text)
codec.hash(algo, text)     -- sha1/sha256/sha384/sha512/md5
codec.randomToken(bytes?)  -- secure random base64url token
codec.uuid()               -- uuid v4
```

### 16.7. `fs` (sandboxed file access)
```tl
fs.read(path)          -- string
fs.write(path, content)  -- true (create-only: refuses to clobber an existing file, must stay in fs.root)
fs.write(path, content, overwrite)  -- true, overwrite=true (3rd arg) replaces the file
fs.append(path, content)
fs.list(path)          -- string[]
fs.mkdir(path)
fs.remove(path)        -- file or empty dir
fs.rmtree(path)        -- recursive remove
fs.exists(path)        -- boolean
fs.isDir(path)         -- boolean
fs.size(path)          -- bytes (number)
```

Writes, appends, mkdir, remove, and rmtree are all **create-only or require
`fs.allowWrite`**. Paths are resolved relative to `fs.root` and must not escape
it (path-traversal checks apply).

### 16.8. `log`
```tl
log.info(...args)
log.warn(...args)
log.error(...args)
log.debug(...args)     -- only if DEBUG=1
```

`log.error` writes to the process logger at ERROR level. `log.warn` writes WARN.
`log.debug` is a no-op unless the `DEBUG=1` env var is set.

### 16.9. `node` (guarded)
```tl
node.child_proc.run(cmd: string) -> { stdout: string, stderr: string, exitCode: number }
node.child_process.run(cmd)       -- alias of child_proc.run
node.bcrypt.hash(password, rounds?) -> string
node.bcrypt.compare(password, hash) -> boolean
node.bcrypt.generateSalt(rounds?)   -> string
```

`node.enabled` must be true, and the command must match `allowedCommands` (or
not match `deniedCommands`). The exec is spawned with a hard timeout.

### 16.10. `Array`
```tl
Array.slice(arr, start, end?) -> array
Array.push(arr, item)         -> array (mutates)
Array.length(arr)             -> number
Array.range(start, end?, step?) -> number[]
Array.repeat(item, count)     -> array
```

### 16.11. `Object`
```tl
Object.keys(obj)      -> string[]
Object.values(obj)
Object.entries(obj)   -> [key, value][]
Object.fromEntries(pairs) -> object
Object.merge(a, b)    -> object
Object.freeze(obj)    -> object (read-only)
```

### 16.12. `agent` and `db`

`agent` exposes the running agent's capabilities: `generate_text`,
`generate_image`, `generate_audio`, `generate_video`, `transcript(audio_url)`
(each needs the matching model type configured, else it fails loudly) and
`rerank(query, documents)` which posts to `[agent.models].rerank_model`'s
`/rerank` endpoint and returns `[{ index, score }]` best-first.
`db` exposes the configured
database backend. Both are injected via `extraVars` for the duration of the tool
run. Consult the `agent`/`db` module docs for their exact surfaces; they mirror
the same `extraVars` contract.

### 16.13. `regex` (guarded regular expressions)

```tl
regex.test(pattern, text, flags?)     -- boolean
regex.match(pattern, text, flags?)    -- { match, index, groups } or null
regex.matchAll(pattern, text, flags?) -- array of { match, index, groups } (capped at 1000)
regex.replace(pattern, text, replacement, flags?) -- string ($1 group refs work)
```

Flags: `dgimsuy` only. Guards (patterns come from the model, and a running JS
match cannot be interrupted): pattern <= 300 chars, text <= 50000 chars,
1000 matches max, and patterns with a quantified group containing a
quantifier or alternation (`(a+)+`, `(a|aa)+`) are refused as exponential
backtracking. NOTE: in a .tl string literal a backslash escape eats the
unknown letter (`"\\d"` in source becomes `d`): write `[0-9]` character
classes, or double the backslash (`"\\\\d"`).

---

## 17. Security and permission matrix

### 17.1. Permission model

The interpreter enforces permissions in this order:
1. **Tool argument validation** — the tool declares `arguments` + `disallow` (plus `optional: true` for arguments the caller may omit: they arrive as `""` / `0` / `false`).
2. **Config limits** — step/loop/call-depth/output budgets.
3. **Module gates** — `fs.allowWrite`, `node.enabled` + command allowlist,
   `http` allowlist/blockPrivate, `docker.enabled`, `skills.allowEnvAccess`.
4. **Runtime guards** — `maxLoopIterations`, `maxCallDepth`, `maxSteps`.

A tool can be disabled at load time (config `tools.disabled`) or at runtime by a
dashboard toggle. A disabled tool refuses execution immediately.

### 17.2. Filesystem sandboxes

* `fs.allowWrite = false` → only `fs.read` (and `exists`/`isDir`/`size`) are
  allowed.
* `fs.root` = a directory; every `fs` path is resolved inside it.
* `..` traversal, absolute paths outside `fs.root`, and symlink escapes are
  rejected with `fs.read` returning `undefined` (or an error string).

### 17.3. Network guard

* `http.allowedHosts` — explicit allowlist. If unset, defaults to allowing all
  except private range.
* `http.blockPrivate = true` → blocks `10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`, `127.0.0.0/8`, `::1`, `fe80::/10`, `fc00::/7`.
* `http.allowedMethods` — restrict to `GET`, `POST`, etc. Default allows all.
* `http.maxResponseBytes` and `http.timeoutMs` cap payload and latency.

### 17.4. `node` security

`node.child_proc.run` executes the command with a timeout. The command is
matched against `node.allowedCommands` (whitelist) and `node.deniedCommands`
(blacklist). Never pass user input verbatim into a node command without
validation — it is process execution, not file I/O.

### 17.5. Secrets

* Never `return` secrets, tokens, or raw error internals from a tool.
* Use `codec.hash(...)` for safe digests; do not log or build responses from
  raw tokens.
* The dashboard passcode and Discord bot token come from env vars
  (`DASHBOARD_PASSCODE`, `DISCORD_TOKEN`) or config; they are hashed before
  storage.

### 17.6. Owasp-aware defaults

* All DB writes are parameterized (no string interpolation into SQL).
* Auth tokens are long, random, and revocable; refresh tokens rotate.
* Audit logging records actor, action, target, details — never credentials.
* CORS is restricted to the dashboard origin; `addons`/`tools`/`skills` respect
  `allowEnvAccess` (default false).

---

## 18. Tool loading pipeline

1. `ToolRegistry.loadAll()` scans `config.tools.directories` for `*.tl` files.
2. `parseToolFile(path)` → `ParsedTool { header, body }`.
3. Header validation:
   * `header.name` must match `/^[a-z][a-z0-9_]{1,63}$/`.
   * `arguments` entries validated (type in allowed set, `disallow` is string[], `optional` only honored as a real boolean `true`).
4. `ToolRegistry.loadOne(path)` reads the file, parses, builds a `LoadedTool`
   with an `invoke` closure. Missing/hidden/disabled tools are skipped.
5. `ToolRegistry.loadAll()` returns `{ loaded, skipped }`.
6. At runtime, the dashboard, agent, and bot consult `isEnabled(name)` which
   combines config `disabled`, `tools.disabled`, and runtime toggles.

---

## 19. `db` backend selection and factory

The database backend is chosen via `config.database.use`:

```
allowed drivers: "sqlite" | "postgres" | "mariadb" | "mongodb" | "cassandra"
default:         "sqlite"
```

`db/index.ts` exports `createDB(config)`. It:
* reads `config.database.use`,
* warns and falls back to `sqlite` on an unknown driver,
* returns the concrete backend (each `implements DB`),
* validates driver-specific config (postgres/mariadb port ranges, mongodb uri +
  database, cassandra contact_points + keyspace).

`src/index.ts` then runs `await db.init()` so every backend (including
filesystem-backed sqlite) has run its schema bootstrap before the process
continues.

### 19.1. Schema contract

All backends implement the same interface (struct.ts): `init`, `close`,
`getUser`, `upsertUser`, `audit`, `recentAudit`, `pruneAudit`, `recordToolRun`,
`toolStats`, `pruneToolRuns`, `kvGet`, `kvSet`, `kvDelete`, `recordChat`,
`recentChats`, `chatsByUser`, plus optional live hooks
`setOnToolRun` / `setOnAudit`. The methods return `Promise<T>`.

### 19.2. Retention

`pruneAudit(beforeMs)` and `pruneToolRuns(beforeMs)` delete records older than
`beforeMs` epoch ms and return the count removed. The dashboard and agent call
these through retention policies configured elsewhere in the app.

---

## 20. CLI / trainer modes

The interpreter is also used in a CLI context. A common workflow is:

```bash
# run a tool file directly with a JSON args blob
node -e "const {parseToolSource, executeToolSource} = require('./src/utils/toolang/index.js'); ..."
```

There is no dedicated `train` command in this repository; the skill is the
training surface. When the agent is asked to write or fix a `.tl` tool, it
should:
1. Read the existing tool file.
2. Compare against this skill (header JSON + syntax + safety).
3. Rewrite the body, keeping the `¤` delimiter.
4. Re-run `bun run typecheck` to confirm nothing else broke.

---

## 21. Runtime trace and debug interface

### 21.1. `log` channels

```
log.info("read", name)          -- always visible
log.warn("missing", path)       -- visible by default
log.error("boom", err)          -- visible, tied to stack traces in logs
log.debug("deep", detail)       -- only with DEBUG=1
```

There is no `console`. Do not `return` logs; they are rendered by the agent
infra.

### 21.2. Debugging a failing tool

1. Read the logged error (it is the `throw` message, JSON-stringified if an
   object).
2. Reproduce with a JSON args blob in the registry tests.
3. Add `log.info` before the failure point to narrow the variable shape.
4. Check `typeof` and length caps.
5. Re-run. The tool cache invalidates on file change, so edits are reflected
   without restarting.

### 21.3. Resource pressure

If a tool hangs, check:
* `maxLoopIterations` / `maxSteps` (throttled loops throw),
* `maxCallDepth` (unbounded recursion),
* `db` queries (an unindexed `SELECT` can block),
* `http` to a slow endpoint (apply a timeout or a smaller payload).

---

## 22. Migration cheat sheet

### 22.1. To TOOLANG

| front-end idiom | TOOLANG |
|-----------------|---------|
| `x = 1` | `set var x to 1` |
| `x += 1` | `x += 1` |
| `x = x * 2` | `x = x * 2` or `x *= 2` |
| `if (x) { ... }` | `if (x) then ... close` |
| `if (x) a else b` | `if (x) then a else b close` |
| `for (let i=0; i<n; i++)` | `for i in Array.range(0, n) do ... close` (or a while) |
| `for (const k of obj)` | `for key in obj do ... close` |
| `while (c) { s }` | `while (c) do ... close` |
| `try { s } catch (e) { ... }` | `try do ... catch e do ... close` |
| `throw new Error("x")` | `throw("x")` |
| `obj.method(args)` | `obj.method(args)` (same notation; no `this`) |
| `arr[0]` | `arr[0]` (index access) |
| `` `hello ${x}` `` | `"hello ${x}"` |
| `console.log(x)` | `log.info(x)` |
| `result ?? fallback` | `result || fallback` (or explicit typeof) |

### 22.2. From Python

```py
# python
if x > 0:
    print(x)
elif x == 0:
    print(0)
else:
    print(-x)
```

```tl
if (x > 0) then
  return(x)
elif (x == 0) then
  return(0)
else
  return(-x)
close
```

```py
# python
for i in range(10):
    if i % 2 == 0:
        continue
    print(i)
```

```tl
for i in Array.range(0, 10) do
  if (i % 2 == 0) then
    continue
  close
  return(i)
close
```

### 22.3. From JavaScript

```js
// js
function double(n) { return n * 2; }
const out = double(21);
```

```tl
fn double(n) do
  return(n * 2)
close

set var out to call(double, 21)
```

### 22.4. From Crystal

```crystal
# crystal
def double(n)
  n * 2
end

puts double(21)
```

```tl
fn double(n) do
  return(n * 2)
close

set var out to call(double, 21)
```

### 22.5. From TypeScript

```ts
// ts
export function double(n: number): number {
  return n * 2;
}
```

```tl
fn double(n) do
  return(n * 2)
close
```

---

## 23. Conformance / test coverage matrix

Use this table to drive regression tests for a new or fixed backend:

| Area | Test | expected |
|------|------|----------|
| `init` | create tables (sqlite/postgres/mariadb/mongo/cassandra) | success, tables exist |
| `getUser` | missing id | `undefined` |
| `upsertUser` | fresh + existing row | row persisted, `updated_at` advances |
| `recordToolRun` | success + failure | rows with correct `success`, `error` |
| `toolStats` | one-tool, empty, many | correct `runs`, `failures`, `avgMs` |
| `audit` | basic + `pruneAudit` | audit row present, removed past cutoff |
| `recentAudit` | limit | newest rows, sorted desc |
| `kvGet` / `kvSet` / `kvDelete` | set, get, overwrite, delete, missing | correct shapes |
| `recordChat` / `recentChats` / `chatsByUser` | chat row, limit, author filter | correct shapes & order |
| `close` | graceful drain | no crash, close idempotent |

Backend-specific:
* **sqlite**: fully synchronous; seed file at `modules/data.sqlite`.
* **postgres**: `pg` pool, `BIGINT` parsed as numbers; `ON CONFLICT` upsert.
* **mariadb**: `mariadb` pool; `ON DUPLICATE KEY UPDATE` upsert.
* **mongodb**: collections `users|audit|tool_runs|kv|chats`; unique index on
  `(ns, key)` for kv.
* **cassandra**: day-partitioned tables; `CREATE KEYSPACE IF NOT EXISTS` first.

---

## 24. Glossary

| term | meaning |
|------|---------|
| TOOLANG / TooLang | the interpreted language for `.tl` tool files |
| `¤` delimiter | separates JSON header from program body |
| `args` | parsed tool arguments injected into the body |
| `set var` | declare + initialise a variable |
| `fn ... do ... close` | function definition |
| `call(...)` | function call statement |
| `return` | value return; unwinds the current block |
| `try / catch` | exception handling; budget errors escape |
| `throw` | raise a `TooLangError` |
| `break` / `continue` | loop control |
| `extraVars` | top-level variables injected into the tool (addon modules) |
| `InterpreterContext` | config + limits + sandbox + logger for one tool run |
| `ToolRegistry` | discovers and validates `*.tl` files |
| `DB` interface | the shared database contract across back ends |
| `pruneAudit` / `pruneToolRuns` | delete records older than epoch ms |
| `ALLOWED` | driver name allowlist for `db` |
| `log` | sandboxed logger; no `console` |

---

## 25. Checklist before you publish a new tool

- [ ] Header `name` matches `/^[a-z][a-z0-9_]{1,63}$/`.
- [ ] `description` is concise and useful to the LLM.
- [ ] Every declared argument is validated (`typeof`, length, range).
- [ ] `disallow` list is non-empty when the argument is sensitive.
- [ ] An argument is marked `optional` only when the body handles its empty default (`""` / `0` / `false`).
- [ ] Only one top-level `return`; it is the last statement of the happy path.
- [ ] File uses `fs` only within `fs.root` when `fs.allowWrite` is false.
- [ ] Network calls respect `http.allowedHosts` / `blockPrivate`.
- [ ] No secrets in logs or responses.
- [ ] Example comment at the bottom (`-- example: ...`).
- [ ] `bun run typecheck` passes for the whole project.

---

## 26. Further reading

* The SQLite backend: `src/db/sqlite.ts` (synchronous reference).
* The DB interface: `src/db/struct.ts`.
* The factory: `src/db/index.ts` (driver allowlist + fallback).
* The tool registry and loader: `src/modules/tools.ts`, `parseToolSource` in
  `src/utils/toolang/index.ts`.
* The evaluator and AST: `src/utils/toolang/evaluator.ts`, `ast.ts`, `lexer.ts`,
  `parser.ts`.
* The builtin modules: `src/utils/toolang/builtins/*`.

*End of TOOLANG reference (part 2).*
