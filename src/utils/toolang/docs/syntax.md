# TooLang Syntax Reference

TooLang is a custom interpreted language designed for agent tooling.
Every `.tl` file starts with a **tool header** (JSON) followed by a `¤` delimiter,
then the program body.

## File Structure

```tl
{
  "name": "tool_name",
  "description": "What this tool does",
  "arguments": [
    {
      "type": "string",
      "name": "arg1",
      "description": "An argument",
      "disallow": []
    }
  ]
}¤

--= program body starts here
```

The `¤` character separates the tool header from the code body.

---

## Comments

```tl
--= this is a user comment (ignored by interpreter)
```
Anything after `--=` on a line is ignored.

---

## Variables

```tl
set var <name> to <expression>
```

```tl
set var zero to 0
set var nothing to ""
set var nothingness to null
set var no to false
set var yes to true
set var result to http.get("https://example.com")
```

Variables are dynamically typed. The `var` keyword is required after `set`.

### Assignment

Existing variables (and members/indexes) can be reassigned:

```tl
x = 5
x += 1          --= also -= *= /= %= 
obj.name = "befaci"
arr[0] = "first"
```

---

## Operators

| category | operators |
|----------|-----------|
| arithmetic | `+` `-` `*` `/` `%` `**` |
| comparison | `==` `!=` `<` `<=` `>` `>=` |
| logic | `&&` `\|\|` `!` (or `and` `or` `not`) |
| concat | `+` also concatenates strings and arrays |

Precedence follows the usual math rules: `1 + 2 * 3` is `7`, `2 ** 10` is
`1024` (right-associative).

---

## Functions

### Definition

```tl
fn <name> with (<param>: <type>, ...) do
  <body>
close
```

Types: `string`, `number`, `boolean`

```tl
fn greet with (name: string) do
  set var msg to "hello {0}".format([name])
  return(msg)
close
```

### Calling

Use the `call` keyword:

```tl
call(<function_name>, <arg1>, <arg2>, ...)
```

```tl
set var result to call(greet, "world")
call(print_result, result)
```

---

## Control Flow

### If / Else

```tl
if <condition> then
<body>
else
<body>
close
```

```tl
if discord.has_role("member_id", "role_id") then
call(do_something)
else
call(do_other_thing)
close
```

Nested `if` inside `else` works too:

```tl
if condition_a then
call(action_a)
else
if condition_b then
call(action_b)
return()
close
call(default_action)
close
```

### While Loop

```tl
while <condition> do
<body>
close
```
```tl
while count < 10 do
set var count to count + 1
close
```

Loops have a hard iteration cap from config; `while true` without a `break`
will be killed by the interpreter.

### For .. In Loop

Iterate over arrays, strings (as chars) or objects (as keys):

```tl
for item in ["a", "b"] do
log.info(item)
close

for ch in "hello" do
log.info(ch)
close

for key in config do
log.info(key)
close
```

### Break / Continue

```tl
for x in Array.range(0, 10) do
if x == 3 then continue close
if x == 8 then break close
log.info(x)
close
```

---

## Error Handling

```tl
try do
<possibly failing body>
catch e do
<recovery, e holds the error message>
close
```

```tl
try do
set var data to json.to("not json")
catch e do
log.error("bad json: ${e}")
close
```

Raise your own errors with `throw`:

```tl
if args.n < 0 then
throw("n must be positive")
close
```

Interpreter limit violations (loop caps, step budget) can NOT be caught.

---

## Return

```tl
return(<expression>)
return()
```

`return` exits the current function (or the top-level program) with a value.
`return()` returns `null`.

```tl
fn add with (a: number, b: number) do
return(a + b)  -- note: arithmetic not shown but supported via native operators
close
```

---

## Expressions

### Literals

| Type     | Example                 |
|----------|-------------------------|
| String   | `"hello world"`         |
| Number   | `42`, `3.14`, `-7`      |
| Boolean  | `true`, `false`         |
| Null     | `null`                  |

### String Interpolation

Two options: `${expr}` holes (variables, literals and member access) or
`.format()` with 1-based `{n}` placeholders:

```tl
set var name to "befaci"
set var greeting to "hello ${name}, welcome to TooLang"
set var same to "hello {1}, welcome to {2}".format([name, "TooLang"])
```

Placeholders are 1-based: `{1}` is the first array element.

### Member Access

Access properties on objects:

```tl
set var req to http.get("https://api.example.com")
set var status to req.status
set var body to req.response
```

### Index Access

Access array/string elements:

```tl
set var first to results[0]
set var char to "hello"[1]
```

### Method Calls

Call methods on values (full lists in [builtins.md](./builtins.md)):

```tl
-- String methods
"".replace("a", "b")
"".toUpperCase()
"".isEmpty()
"".length()

-- Number methods
3.14.round()
(5).clamp(0, 10)

-- Array methods
[].push("item")
[].unique()
[].sum()
[].length()

-- Object methods
{}.keys()
{}.merge({ a: 1 })
```

### Object Literals

```tl
set var config to { name: "my_container", image: "nginx:latest" }
set var empty to {}
```

String keys are also valid:

```tl
set var data to { "name": "value", "count": 42 }
```

### Array Literals

```tl
set var items to [1, 2, 3]
set var mixed to ["hello", 42, true]
set var empty to []
```

---

## Built-in Modules

See [builtins.md](./builtins.md) for the full list of built-in modules:
`http`, `json`, `math`, `time`, `codec`, `fs`, `log`, `node`, `Array`,
`Object`, `docker`, `discord`, `agent`.

Note: `to`, `in`, `do`, `call` etc. remain valid property names after a dot,
so `json.to(...)` works even though they are keywords.

-# this markdown file has been generated via artificial intelligence
