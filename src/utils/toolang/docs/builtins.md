# TooLang Built-in Modules

All modules are available globally. No imports needed.
Most modules are restricted by [agent.toolang.*] config policies.

---

## http

HTTP client. All methods return `{ status: number, response: string, headers: {} }`.

```tl
http.get(url)
http.post(url, body?)
http.put(url, body?)
http.patch(url, body?)
http.delete(url)
http.head(url)
http.options(url)
```

```tl
set var res to http.get("https://api.example.com/data")
set var status to res.status
set var body to json.to(res.response)
```

Policy (from config): private/internal hosts are blocked by default
(SSRF protection), optional host allow/blocklists, method allowlist,
response size cap, request timeout. Redirects are refused.

---

## math

```tl
math.rand(min?, max?)     math.randInt(min, max)
math.clamp(v, lo, hi)     math.min(...n)   math.max(...n)
math.abs(n)               math.sign(n)
math.round(n)             math.floor(n)    math.ceil(n)
math.sqrt(n)              math.pow(b, e)   math.log(n)
math.sin(n)  math.cos(n)  math.tan(n)  math.atan2(y, x)
math.PI                   math.E
```

---

## time

```tl
time.now()          --= epoch ms
time.timestamp()    --= epoch seconds
time.iso()          --= ISO 8601 string
time.fromIso(str)   time.toIso(ms)
time.year(ms?)      time.month(ms?)   time.day(ms?)      --= utc
time.hour(ms?)      time.minute(ms?)  time.second(ms?)   time.weekday(ms?)
time.humanize(seconds)  --= "1h 02m 03s"
time.uptime()       --= process uptime seconds
```

---

## codec

```tl
codec.base64Encode(text)   codec.base64Decode(text)
codec.hexEncode(text)      codec.hexDecode(text)
codec.urlEncode(text)      codec.urlDecode(text)
codec.hash(algo, text)     --= sha1|sha256|sha384|sha512|md5 -> hex
codec.randomToken(bytes?)  --= secure random base64url token (8..128 bytes)
codec.uuid()               --= uuid v4
```

---

## fs

Sandboxed filesystem: every path is jailed inside the configured root,
symlinks pointing outside are refused, traversal (`..`) cannot escape.
Writes require `allow_write = true` in config; `fs.write` never overwrites.

```tl
fs.read(path)        fs.exists(path)     fs.list(path)
fs.isDir(path)       fs.size(path)
fs.write(path, text) fs.append(path, text)
fs.mkdir(path)       fs.remove(path)     --= remove: files/empty dirs only
fs.rmtree(path)      --= recursive, refuses the sandbox root itself
```

---

## log

```tl
log.info(...)   log.warn(...)   log.error(...)   log.debug(...)
```
`log.debug` only prints when DEBUG=1. Output is size-capped.

---

## json

JSON parsing and serialization.

```tl
json.to(text) --= parse JSON string -> object
json.from(obj) --= stringify object -> JSON string
```

```tl
set var data to json.to("{\"key\": \"value\"}")
set var text to json.from({ key: "value" })
```

---

## node / nodejs

Node.js built-in wrappers, gated by [agent.toolang.node] config.

### child_process

```tl
node.child_proc.run(cmd)      --= returns { stdout, stderr, exitCode }
node.child_process.run(cmd)   --= alias
nodejs.child_process.run(cmd) --= alias
```

No shell is spawned (the command is split safely). Commands are checked
against an allowlist/denylist from config; sudo, curl, ssh, etc. are denied
by default.

```tl
set var result to node.child_proc.run("ls -la")
set var output to result.stdout
```

### bcrypt

Password hashing (requires `bcrypt` package: `yarn add bcrypt @types/bcrypt`).

```tl
node.bcrypt.hash(password, salt?)
node.bcrypt.compare(password, hash)
node.bcrypt.generateSalt(rounds?)
```

```tl
set var hashed to call(node.bcrypt.hash, "mypassword")
set var match to call(node.bcrypt.compare, "mypassword", hashed)
```

---

## Array

Static array utilities.

```tl
Array.slice(arr, start, end?)  --= sliced copy
Array.push(arr, item)          --= new array with item appended
Array.length(arr)              --= number of elements
Array.range(start, end?, step?) --= [0, 1, ...] number ranges
Array.repeat(item, count)      --= [item, item, ...]
```

```tl
set var first5 to Array.slice(results, 0, 5)
set var extended to Array.push([1, 2], 3)
set var count to Array.length([1, 2, 3])
set var grid to Array.range(0, 10, 2)  --= [0, 2, 4, 6, 8]
```

---

## Object

```tl
Object.keys(obj)         Object.values(obj)      Object.entries(obj)
Object.fromEntries(pairs)  Object.merge(a, b)   Object.freeze(obj)
```

---

## docker

Docker container management via the Docker CLI. All methods return
`{ stdout: string, stderr: string, exitCode: number }`.

### Container lifecycle

```tl
docker.run(container, cmd) --= exec command in container
docker.create(name, image, config?) --= create container
docker.remove(container) --= force remove
docker.start(container)
docker.restart(container)
docker.stop(container)
docker.recreate(container) --= stop + remove
docker.edit(container, config?) --= edit or recreate with new image
```

### Config object for create/edit

```tl
docker.create("my_app", "nginx:latest", { memory: "2G", cpu: 150, ports: [8080], volumes: [{ host: "/data", container: "/app/data" }], additional_args: ["--restart", "always"] })
```

To replace the image (triggers recreate):

```tl
docker.edit("my_app", { image: "nginx:alpine", memory: "1G" })
```

### Container info

```tl
docker.get_info(container) --= full inspect output
docker.get_state(container) --= "running", "stopped", etc.
docker.get_resources(container) --= stats (CPU, memory, etc.)
docker.get_console_logs(container) --= last 100 lines of logs
```

### File operations

```tl
docker.get_file_content(container, path)
docker.rmfile(container, path)
docker.mvfile(container, from, to)
docker.edit_file(container, path, content) --= creates if not exists
docker.mkdir(container, path, recursive?)
docker.rmdir(container, path, force?)
docker.lsdir(container, path, recursive?)
docker.mvdir(container, from, to)
```

```tl
set var config to docker.get_file_content("web", "/etc/nginx/nginx.conf")
docker.edit_file("web", "/app/index.html", "<h1>Hello</h1>")
docker.mkdir("web", "/app/data", true)
```

---

## discord

Discord.js wrapper. Requires a Discord.js `Client` to be passed via `InterpreterContext`.

### Messages

```tl
discord.send_message(content, options?)
discord.reply(message_id, content, options?)
discord.edit_message(message_id, content, options?)
discord.delete_message(message_id)
discord.get_message(message_id)
discord.react(message_id, emoji)
discord.delete_reaction(message_id, emoji)
```

Options object:

```tl
discord.send_message("hello", { embeds: [discord.make_embed({ title: "Hi", description: "test" }, [])], attachments: [discord.make_attachment({ name: "file.txt", type: "custom", data: "content" })] })
```

### Embeds and Attachments

```tl
discord.make_embed(data, components?)
discord.make_attachment(data)
```

Embed data:
```tl
discord.make_embed({ author: { name: "Bot", icon_url: "https://..." }, title: "Title", description: "Description", fields: [{ name: "Field", value: "Value" }], footer: { text: "Footer", icon_url: "https://..." } }, [ [{ "type": "button", "label": "Click", "emoji": "👍", "style": "primary" }], { type: "select", options: [{ label: "Option 1", value: "opt1" }], placeholder: "Pick one" } ])
```

Attachment types:
```tl
--= URL attachment
discord.make_attachment({ name: "image.png", type: "http", data: "https://..." })
--= Custom content
discord.make_attachment({ name: "file.txt", type: "custom", data: "Hello World" })
```

### Polls and Stickers

```tl
discord.send_poll(title, options, duration_hours)
discord.send_sticker(sticker_id)
```
```tl
discord.send_poll("Favorite color?", [ { label: "Red", emoji: "🔴" }, { label: "Blue", emoji: "🔵" } ], 24)
```

### Emojis

```tl
discord.get_server_emojis()
discord.create_emoji(name, image_url)
discord.edit_emoji(emoji_id, new_name)
discord.delete_emoji(emoji_id)
```

### Stickers

```tl
discord.get_server_stickers()
discord.create_sticker(name, image_url)
discord.edit_sticker(sticker_id, new_name)
discord.delete_sticker(sticker_id)
```

### Soundboards

```tl
discord.get_server_soundboards()
discord.create_soundboard(name, audio_url)
discord.delete_soundboard(soundboard_id)
```

### Channels

```tl
discord.get_all_channels()
discord.create_channel(name, type?)
discord.duplicate_channel(channel_id, new_name?)
discord.recreate_channel(channel_id)
discord.edit_channel(channel_id, data)
discord.delete_channel(channel_id)
discord.get_channel(channel_id)
discord.channel_exists(channel_id)
```
Channel types: `"announcement"`, `"voice"` (defaults to text).

Edit data:
```tl
discord.edit_channel("123456", { name: "new-name", slowmode: 10, topic: "Updated topic", nsfw: false, parent_id: "category_id", position: 0, permissions: [], flags: 0, bitrate: 64, user_limit: 0 })
```

### Threads

```tl
discord.create_thread(channel_id, name, message_id?)
discord.edit_thread(thread_id, data)
discord.delete_thread(thread_id)
```

### Categories

```tl
discord.create_category(name)
discord.edit_category(category_id, data)
discord.delete_category(category_id)
```

### Roles

```tl
discord.get_all_roles()
discord.create_role(data)
discord.edit_role(role_id, data)
discord.delete_role(role_id)
```

```tl
discord.create_role({ name: "Helper", color: 0x00ff00, hoist: true, mentionable: false, permissions: [] })
```

### Scheduled Events

```tl
discord.list_scheduled_events()
discord.schedule_event(name, description, where, cover_url?)
discord.edit_event(event_id, data, cover_url?)
discord.delete_event(event_id)
```
Where object: `{ type: "voice"|"text", value: "channel_id" }` or `{ type: "external", value: "location string" }`.

### Members

```tl
discord.kick_member(member_id, reason?)
discord.ban_member(member_id, reason?)
discord.unban_member(member_id, reason?)
discord.timeout_member(member_id, duration_seconds, reason?)
discord.untimeout_member(member_id, reason?)
discord.grant_role(member_id, role_id, reason?)
discord.revoke_role(member_id, role_id, reason?)
discord.has_role(member_id, role_id)
```

---

## agent

AI agent integration. Requires an `Agent` instance to be passed via `InterpreterContext`.

```tl
agent.generate_text(prompt, attachments?) --# attachments is an array
--# e.g.: agent.generate_text("Explain quantum computing", [{ type: "image", data: "https://..." }, { type: "audio", data: "https://..." }])
agent.generate_image(prompt)
agent.generate_audio(prompt)
agent.generate_video(prompt)
agent.transcript(audio_url)
```
```tl
set var transcript to agent.transcript("https://...")
set var response to agent.generate_text(transcript.text)
set var image to agent.generate_image("a sunset over mountains")
```

-# this markdown file has been generated via artificial intelligence
