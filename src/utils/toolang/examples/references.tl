{
	"name": "list_refs",
	"description": "List all of the references from TooLang",
	"arguments": [
		{
			"type": "string",
			"name": "one",
			"description": "stuff",
			"disallow": []
		},
		{
			"type": "boolean",
			"name": "∢",
			"description": "thing",
			"disallow": []
		},
		{
			"type": "number",
			"name": "3",
			"description": "any",
			"disallow": []
		}
	]
}¤

--= no tabs
set var zero to 0
set var nothing to ""
set var nothingness to null
set var no to false
set var yes to true

json.to("['this','quote','is',\"converted\",\"to\",'doublequote']") --= converts to json
json.from(["hi","world"]) --= converts to a string

http.get()
http.post()
http.put()
http.patch()
http.delete()
http.head()
http.options()

Array.slice(arr, 0, 99) --= this is the only exception here
[].push("something")
[].pop()
[].shift()
[].unshift()
[].reverse()
[].join("separator")
[].map()
[].len --= aka length

"".replace("a", "2")
"".replaceAll("1", "b")
"".substr(0, 2)
"".toUpperCase()
"".toLowerCase()
"".trim()
"".toNumber()
--= or you can do 1 instead of true and same for false
"true".toBoolean()

0.toString()
0.toFixed(2)
0.toBoolean()

node.child_proc.run("cat /etc/passwd")
node.bcrypt.hash("password", "optional salt here")
node.bcrypt.compare("password", "hash")
node.bcrypt.generateSalt(16)

math.rand(0,1)
math.clamp()
math.max()
math.min()
math.abs()
math.round()
math.floor()
math.ceil()
math.sin()
math.cos()
math.tan()
math.PI

docker.run("container", "cmd")
--= json can only be on one line
docker.create("container_name", "image:here", { memory: "2G", cpu: 150, ports: [8080], volumes: [{ volume: "webdata", container: "/data" }], additional_args: [] })
--= volume ids resolve to sandbox/.docker-vols/<id>; { host: "/path", container: "/data" } needs allowed_volume_paths
docker.attach("container_name", "webdata", "/data") --= mount a volume into an existing container, then start it
docker.recreate("container")
docker.edit("container", { memory: "2G", cpu: 150, ports: [8080], volumes: [{ host: "", container: "" }], additional_args: [] })
--= will recreate the container if a docker image is provided
docker.edit("container", { memory: "2G", cpu: 150, ports: [8080], volumes: [{ host: "", container: "" }], additional_args: [], "image": "new_image:here" })
docker.remove("container")
docker.start("container")
docker.restart("container")
docker.stop("container")
docker.get_info("container") --= wont spit out the resource usage, use docker.get_resources for that
docker.get_state("container") --= if online/offline
docker.get_resources("container")
docker.get_console_logs("container")
docker.get_file_content("container", "path/to/file")
docker.rmfile("container", "path/to/file")
docker.mvfile("container", "path/to/file", "new/path")
docker.edit_file("container", "path/to/file", "new content") --= if file does not exist, create it
docker.mkdir("container", "path/to/dir", true) --= true means create dir recursively
docker.rmdir("container", "path/to/dir", true) --= true means remove dir forcibly
docker.lsdir("container", "path/to/dir", true) --= true means list dir recursively
docker.mvdir("container", "path/to/dir", "new/path")

discord.make_embed({ author: { name: "", icon_url: "" }, title: "", description: "", fields: [{ name: "", value: "" }], footer: { text: "", icon_url: "" } }, [[{ "type": "button", "label": "", "emoji": "", "style": "primary/secondary/danger/success" }], { type: "select", options: [{ label: "", value: "" }], placeholder: "Second row, select menu needs to be alone in a row so this is only a JSON object" }])
discord.make_attachment({ name: "", type: "http", data: "https://" })
discord.make_attachment({ name: "", type: "custom", data: "Hello, World! I can also put binary in here (hopefully)" })
discord.make_msgv2() --= TODO
discord.send_message("message content", { embeds: [discord.make_embed(...)], "attachments": [discord.make_attachment({...})] })
discord.react("message_id", "emoji")
discord.delete_reaction("message_id", "emoji")
discord.reply("message_id", "message content")
discord.reply("message_id", "message content", { embeds: [discord.make_embed(...)] })
discord.send_poll("title", [{ "label": "option1", "emoji": "(optional)" }, ...], duration_in_hours)
discord.send_sticker("sticker_id")
discord.edit_message("message_id", "message content", { embeds: [discord.make_embed(...)], "attachments": [discord.make_attachment({...})] })
discord.delete_message("message_id")
discord.get_message("message_id")
discord.get_server_emojis()
discord.create_emoji("emoji_name", "image_url")
discord.edit_emoji("emoji_name", "new_name")
discord.delete_emoji("emoji_id")
discord.get_server_stickers()
discord.create_sticker("sticker_name", "image_url")
discord.edit_sticker("sticker_name", "new_name")
discord.delete_sticker("sticker_id")
discord.get_server_soundboards()
discord.create_soundboard("soundboard_name", "audio_url")
discord.delete_soundboard("soundboard_id")
discord.get_all_channels() --= includes categories
discord.create_channel("channel_name", "announcement")
discord.duplicate_channel("channel_id", "channel_name (nullable)")
discord.recreate_channel("channel_id") --= equivalent to duplicate_channel then delete_channel but in a proper way ;)
discord.edit_channel("channel_id", { "name": "", "slowmode": 0, "topic": "", "nsfw": false, "parent_id": "", "position": 0, "permissions": [], "flags": 0, "bitrate": 64, "user_limit": 0 })
discord.delete_channel("channel_id")
discord.get_channel("channel_id")
discord.channel_exists("channel_id")
discord.create_thread("channel_id", "thread_name", "message_id (nullable)")
discord.edit_thread("thread_id", { "name": "" })
discord.delete_thread("thread_id")
discord.create_category("category_name")
discord.edit_category("category_id", { "name": "", "permissions": [] })
discord.delete_category("category_id")
discord.get_all_roles()
discord.create_role({ "name": "", "color": 0, "hoist": false, "mentionable": false, "permissions": [] })
discord.edit_role("role_id", { "name": "", "color": 0, "hoist": false, "mentionable": false, "permissions": [] })
discord.delete_role("role_id")
discord.list_scheduled_events()
discord.schedule_event("event_name", "event_description", { "where": { "type": "voice/text", "value": "channel_id/string" }, "start_time": "", "end_time": "" }, "https://cover_image_url (nullable)")
discord.edit_event("event_id", { "name": "", "description": "", "where": { "type": "voice/text", "value": "channel_id/string" }, "start_time": "", "end_time": "" }, "https://cover_image_url (nullable)")
discord.delete_event("event_id")
discord.kick_member("member_id", "reason (nullable)")
discord.ban_member("member_id", "reason (nullable)")
discord.unban_member("member_id", "reason (nullable)")
discord.timeout_member("member_id", duration_in_seconds, "reason (nullable)")
discord.untimeout_member("member_id", "reason (nullable)")
discord.grant_role("member_id", "role_id", "reason (nullable)")
discord.revoke_role("member_id", "role_id", "reason (nullable)")
discord.has_role("member_id", "role_id")

agent.generate_text("prompt")
agent.generate_image("prompt")
agent.generate_audio("prompt")
agent.generate_video("prompt")
agent.transcript("audio_url")



fn name with (arg1: string, arg2: number) do
call(name) --= infinite loop
close

while true do
call(name) --= 3d infinite loop (idk why named it like that lmao)
close

if discord.has_role("member_id", "role_id") then

call(name)

else

if discord.channel_exists("channel_id") then --= else if like

call(name)
return()

close

call(name)

close

--= websocket

set var ws to create websocket

ws.conn("wss://rt.example.com", { "headers": { "Authorization": "Bearer abc123" } })

ws.handle("conned", (client, info) ->
agent.send("connected to {1}".format([info.url])) --= console.log-like

--= basically when message received send back with an hello
client.handle("message", (data) ->
agent.send("received message: {1}".format([data]))
if data == "hello world" then
client.send("lorem ipsum")
close
client.close()
close)

client.handle("close", (data) ->
agent.send("closed: {1}".format([data]))
close)
client.handle("error", (data) ->
agent.send("error: {1}".format([data]))
close)

close)

--= socketio

set var socket to create sio.client

socket.connect("ws://localhost:5000")

socket.handle("connect", (data) ->
agent.send("connected: {1}".format([data]))
close)

socket.handle("disconnect", (data) ->
agent.send("disconnected: {1}".format([data]))
close)

socket.handle("message", (data) ->
agent.send("received message: {1}".format([data]))
socket.send("hello world")
close)
