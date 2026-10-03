{
	"name": "server_stats",
	"description": "Give an overview of the Discord server: channels, roles, member count and bot ping",
	"arguments": []
}¤

set var channels to discord.get_all_channels()
set var roles to discord.get_all_roles()
return({
	channels: Object.keys(channels).length,
	roles: Object.keys(roles).length,
	fetched_at: time.iso()
})
