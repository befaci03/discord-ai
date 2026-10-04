/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// Guild-management half of the discord builtin: members, roles, channels,
// threads, categories, expressions (emoji/sticker/soundboard) and events.
// Every MUTATING call is gated: permissions first, then hierarchy/shape, and a
// missing Discord.js lookup becomes a clear error instead of a raw API throw.
// The message / reaction / presence half lives in discord.ts.

import type { Client as DiscordClient, Guild, GuildMember } from 'discord.js';
import {
	DiscordError,
	makeCtx,
	requirePerms,
	requireAnyPerm,
	assertCanActOn,
	assertCanManageRole,
	assertHierarchy,
	assertSnowflake,
	assertTimeoutSeconds,
	sanitizeReason,
	selfFacts,
	memberFacts,
	assertRemoteImageUrl
} from './discordguard.js';

export function Manage(getClient: () => DiscordClient): Record<string, Function> {
	const ctx = makeCtx(getClient);

	/** fetch a channel or fail with a clear error (a raw API throw says nothing) */
	const fetchChannel = async (channelId: string, what: string): Promise<any> => {
		const id = assertSnowflake(channelId, 'channel_id');
		const ch = await getClient()
			.channels.fetch(id)
			.catch(() => null);
		if (!ch) throw new DiscordError(`channel ${id} not found (${what})`);
		return ch;
	};
	/** fetch a member or fail with a clear error */
	const fetchMember = async (guild: Guild, memberId: string, what: string): Promise<GuildMember> => {
		const id = assertSnowflake(memberId, 'member_id');
		const m = await guild.members.fetch(id).catch(() => null);
		if (!m) throw new DiscordError(`member ${id} not found (${what})`);
		return m;
	};
	/** fetch a role or fail with a clear error */
	const fetchRole = async (guild: Guild, roleId: string) => {
		const id = assertSnowflake(roleId, 'role_id');
		const role = await guild.roles.fetch(id).catch(() => null);
		if (!role) throw new DiscordError(`role ${id} not found`);
		return role;
	};
	/** guild-level any-of permission check (Create_X OR Manage_X ...) */
	const guardGuildAny = async (guild: Guild, options: string[], what: string): Promise<GuildMember> => {
		const me = await ctx.requireMe(guild, what);
		requireAnyPerm(ctx.guildView(me), options, what);
		return me;
	};
	/** non-empty, length-capped label: names are untrusted model input */
	const label = (value: unknown, what: string, max: number): string => {
		const s = typeof value === 'string' ? value.trim() : '';
		if (s.length === 0) throw new DiscordError(`${what} must be a non-empty string`);
		if (s.length > max) throw new DiscordError(`${what} too long (${s.length} > ${max})`);
		return s;
	};
	/**
	 * Download an upload asset OURSELVES instead of handing the URL to
	 * discord.js: its resolveFile() fetches with redirects on (SSRF by 302) and
	 * accepts local file paths. We validate the URL, refuse redirects and
	 * private hosts, cap the size, then pass a Buffer (resolveFile returns
	 * buffers untouched: no second fetch, no path resolution).
	 */
	const downloadAsset = async (rawUrl: unknown, what: string, maxBytes: number): Promise<Buffer> => {
		const url = assertRemoteImageUrl(rawUrl, what);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 15_000);
		try {
			const res = await fetch(url, { signal: controller.signal, redirect: 'error' });
			if (!res.ok) throw new DiscordError(`${what}: download failed (HTTP ${res.status})`);
			const declared = Number(res.headers.get('content-length') ?? '0');
			if (declared > maxBytes) throw new DiscordError(`${what}: file too large (${declared} > ${maxBytes} bytes)`);
			const buf = Buffer.from(await res.arrayBuffer());
			if (buf.length > maxBytes) throw new DiscordError(`${what}: file too large (${buf.length} > ${maxBytes} bytes)`);
			return buf;
		} catch (err) {
			if (err instanceof DiscordError) throw err;
			throw new DiscordError(`${what}: could not download the file (${(err as Error).message.slice(0, 200)})`);
		} finally {
			clearTimeout(timer);
		}
	};
	/**
	 * Moderation entry point: guild permission + hierarchy in one place.
	 * Refuses before the API when the bot lacks the permission, when the
	 * target is the bot itself, the owner, or sits at/above its top role.
	 */
	const moderate = async (memberId: string, what: string, need: string[]): Promise<GuildMember> => {
		const id = assertSnowflake(memberId, 'member_id'); // input first, then permissions
		const guild = ctx.getGuild();
		const me = await ctx.guardGuild(guild, need, what);
		const member = await fetchMember(guild, id, what);
		assertCanActOn(selfFacts(me, guild), memberFacts(member, guild), what);
		return member;
	};

	return {
		// ----- expressions: emoji, stickers, soundboard -----
		get_server_emojis: async () => await ctx.getGuild().emojis.fetch(),
		create_emoji: async (name: string, imageUrl: string) => {
			const emojiName = label(name, 'emoji name', 32);
			const guild = ctx.getGuild();
			await guardGuildAny(guild, ['CreateGuildExpressions', 'ManageGuildExpressions'], 'create an emoji');
			const image = await downloadAsset(imageUrl, 'create_emoji', 262_144); // Discord caps emojis at 256 KiB
			return await guild.emojis.create({ attachment: image, name: emojiName });
		},
		edit_emoji: async (emojiId: string, newName: string) => {
			const id = assertSnowflake(emojiId, 'emoji_id');
			const emojiName = label(newName, 'emoji name', 32);
			const guild = ctx.getGuild();
			await ctx.guardGuild(guild, ['ManageGuildExpressions'], 'edit an emoji');
			const emoji = await guild.emojis.fetch(id).catch(() => null);
			if (!emoji) throw new DiscordError('emoji not found');
			return await emoji.edit({ name: emojiName });
		},
		delete_emoji: async (emojiId: string) => {
			const id = assertSnowflake(emojiId, 'emoji_id');
			const guild = ctx.getGuild();
			await ctx.guardGuild(guild, ['ManageGuildExpressions'], 'delete an emoji');
			const emoji = await guild.emojis.fetch(id).catch(() => null);
			if (!emoji) throw new DiscordError('emoji not found');
			return await emoji.delete();
		},

		get_server_stickers: async () => await ctx.getGuild().stickers.fetch(),
		create_sticker: async (name: string, imageUrl: string) => {
			const stickerName = label(name, 'sticker name', 30);
			const guild = ctx.getGuild();
			await guardGuildAny(guild, ['CreateGuildExpressions', 'ManageGuildExpressions'], 'create a sticker');
			const file = await downloadAsset(imageUrl, 'create_sticker', 524_288); // Discord caps stickers at 512 KiB
			return await guild.stickers.create({ name: stickerName, file, tags: stickerName });
		},
		edit_sticker: async (stickerId: string, newName: string) => {
			const id = assertSnowflake(stickerId, 'sticker_id');
			const stickerName = label(newName, 'sticker name', 30);
			const guild = ctx.getGuild();
			await ctx.guardGuild(guild, ['ManageGuildExpressions'], 'edit a sticker');
			const sticker = await guild.stickers.fetch(id).catch(() => null);
			if (!sticker) throw new DiscordError('sticker not found');
			return await sticker.edit({ name: stickerName });
		},
		delete_sticker: async (stickerId: string) => {
			const id = assertSnowflake(stickerId, 'sticker_id');
			const guild = ctx.getGuild();
			await ctx.guardGuild(guild, ['ManageGuildExpressions'], 'delete a sticker');
			const sticker = await guild.stickers.fetch(id).catch(() => null);
			if (!sticker) throw new DiscordError('sticker not found');
			return await sticker.delete();
		},

		get_server_soundboards: async () => {
			return await (ctx.getGuild() as any).soundboardSounds?.fetch();
		},
		create_soundboard: async (name: string, audioUrl: string) => {
			const soundName = label(name, 'soundboard name', 32);
			const guild = ctx.getGuild();
			await guardGuildAny(guild, ['CreateGuildExpressions', 'ManageGuildExpressions'], 'create a soundboard sound');
			const file = await downloadAsset(audioUrl, 'create_soundboard', 524_288);
			return await (guild as any).soundboardSounds?.create({ name: soundName, file });
		},
		delete_soundboard: async (soundId: string) => {
			const id = assertSnowflake(soundId, 'sound_id');
			const guild = ctx.getGuild();
			await ctx.guardGuild(guild, ['ManageGuildExpressions'], 'delete a soundboard sound');
			const sound = await (guild as any).soundboardSounds?.fetch(id).catch(() => null);
			if (!sound) throw new DiscordError('soundboard sound not found');
			return await sound?.delete();
		},

		// ----- channels -----
		get_all_channels: async () => await ctx.getGuild().channels.fetch(),
		create_channel: async (name: string, type?: string) => {
			const guild = ctx.getGuild();
			await ctx.guardGuild(guild, ['ManageChannels'], 'create a channel');
			const channelType = type === 'announcement' ? 5 : type === 'voice' ? 2 : 0;
			return await guild.channels.create({ name: label(name, 'channel name', 100), type: channelType as any });
		},
		duplicate_channel: async (channelId: string, newName?: string) => {
			const guild = ctx.getGuild();
			await ctx.guardGuild(guild, ['ManageChannels'], 'duplicate a channel');
			const ch = await fetchChannel(channelId, 'duplicate');
			return await guild.channels.create({
				name: label(newName ?? `${ch.name ?? 'channel'}-copy`, 'channel name', 100),
				type: ch.type as any,
				topic: 'topic' in ch ? (ch as any).topic : undefined
			});
		},
		recreate_channel: async (channelId: string) => {
			const guild = ctx.getGuild();
			await ctx.guardGuild(guild, ['ManageChannels'], 'recreate a channel');
			const ch = await fetchChannel(channelId, 'recreate');
			const newCh = await guild.channels.create({
				name: label(ch.name ?? 'channel', 'channel name', 100),
				type: ch.type as any,
				topic: 'topic' in ch ? (ch as any).topic : undefined
			});
			await ch.delete();
			return newCh;
		},
		edit_channel: async (channelId: string, data: Record<string, unknown>) => {
			const ch = await fetchChannel(channelId, 'edit');
			await ctx.guardChannel(ch, ['ManageChannels'], `edit channel ${channelId}`);
			if ('edit' in ch) return await (ch as any).edit(data);
			throw new DiscordError(`channel ${channelId} is not editable`);
		},
		delete_channel: async (channelId: string) => {
			const ch = await fetchChannel(channelId, 'delete');
			await ctx.guardChannel(ch, ['ManageChannels'], `delete channel ${channelId}`);
			return await ch.delete();
		},
		get_channel: async (channelId: string) => await fetchChannel(channelId, 'read'),
		channel_exists: async (channelId: string) => {
			const id = assertSnowflake(channelId, 'channel_id');
			const ch = await getClient()
				.channels.fetch(id)
				.catch(() => null);
			return ch !== null;
		},

		// ----- threads -----
		create_thread: async (channelId: string, name: string, messageId?: string) => {
			const ch = await fetchChannel(channelId, 'create a thread');
			await ctx.guardChannelAny(ch, ['CreatePublicThreads', 'ManageChannels'], 'create a thread');
			if (!('threads' in ch)) throw new DiscordError(`channel ${channelId} does not support threads`);
			if (messageId) return await (ch as any).threads.create({ name: label(name, 'thread name', 100), startMessage: assertSnowflake(messageId, 'message_id') });
			return await (ch as any).threads.create({ name: label(name, 'thread name', 100) });
		},
		edit_thread: async (threadId: string, data: Record<string, unknown>) => {
			const ch = await fetchChannel(threadId, 'edit');
			await ctx.guardChannelAny(ch, ['ManageThreads', 'ManageChannels'], 'edit a thread');
			if (!('edit' in ch)) throw new DiscordError(`thread ${threadId} not found`);
			return await (ch as any).edit(data);
		},
		delete_thread: async (threadId: string) => {
			const ch = await fetchChannel(threadId, 'delete');
			await ctx.guardChannelAny(ch, ['ManageThreads', 'ManageChannels'], 'delete a thread');
			return await ch.delete();
		},

		// ----- categories -----
		create_category: async (name: string) => {
			const guild = ctx.getGuild();
			await ctx.guardGuild(guild, ['ManageChannels'], 'create a category');
			return await guild.channels.create({ name: label(name, 'category name', 100), type: 4 as any });
		},
		edit_category: async (categoryId: string, data: Record<string, unknown>) => {
			const ch = await fetchChannel(categoryId, 'edit');
			await ctx.guardChannel(ch, ['ManageChannels'], `edit category ${categoryId}`);
			if (!('edit' in ch)) throw new DiscordError(`category ${categoryId} not found`);
			return await (ch as any).edit(data);
		},
		delete_category: async (categoryId: string) => {
			const ch = await fetchChannel(categoryId, 'delete');
			await ctx.guardChannel(ch, ['ManageChannels'], `delete category ${categoryId}`);
			return await ch.delete();
		},

		// ----- roles -----
		get_all_roles: async () => await ctx.getGuild().roles.fetch(),
		create_role: async (data: Record<string, unknown>) => {
			const guild = ctx.getGuild();
			await ctx.guardGuild(guild, ['ManageRoles'], 'create a role');
			return await guild.roles.create({ ...(data as object), name: label((data as any)?.name, 'role name', 100) } as any);
		},
		edit_role: async (roleId: string, data: Record<string, unknown>) => {
			const id = assertSnowflake(roleId, 'role_id');
			const guild = ctx.getGuild();
			const role = await fetchRole(guild, id);
			const me = await ctx.guardGuild(guild, ['ManageRoles'], 'edit a role');
			assertCanManageRole(me.roles.highest.position, role, guild.id, 'edit');
			return await role.edit(data as any);
		},
		delete_role: async (roleId: string) => {
			const id = assertSnowflake(roleId, 'role_id');
			const guild = ctx.getGuild();
			const role = await fetchRole(guild, id);
			const me = await ctx.guardGuild(guild, ['ManageRoles'], 'delete a role');
			assertCanManageRole(me.roles.highest.position, role, guild.id, 'delete');
			return await role.delete();
		},

		// ----- scheduled events -----
		list_scheduled_events: async () => await ctx.getGuild().scheduledEvents.fetch(),
		schedule_event: async (name: string, description: string, where: { type: string; value: string }, coverUrl?: string) => {
			const guild = ctx.getGuild();
			await guardGuildAny(guild, ['CreateEvents', 'ManageEvents'], 'schedule an event');
			if (!where || typeof where !== 'object') throw new DiscordError('schedule_event: where must be { type: "voice"|"text"|"external", value }');
			const data: Record<string, unknown> = {
				name: label(name, 'event name', 100),
				description: String(description ?? '').slice(0, 1000),
				scheduledStartTime: where.value,
				scheduledEndTime: where.value
			};
			if (where.type === 'voice' || where.type === 'text') data.channel = where.value;
			else {
				// i kinda asked chatgpt for that ('^^)
				data.entityType = 3; // External
				data.entityMetadata = { location: where.value };
			}
			if (coverUrl) data.image = coverUrl;
			return await guild.scheduledEvents.create(data as any);
		},
		edit_event: async (eventId: string, data: Record<string, unknown>, coverUrl?: string) => {
			const id = assertSnowflake(eventId, 'event_id');
			const guild = ctx.getGuild();
			const event = await guild.scheduledEvents.fetch(id).catch(() => null);
			await ctx.guardGuild(guild, ['ManageEvents'], 'edit an event');
			if (!event) throw new DiscordError(`event ${id} not found`);
			const editData: Record<string, unknown> = { ...data };
			if (coverUrl) editData.image = coverUrl;
			return await event.edit(editData as any);
		},
		delete_event: async (eventId: string) => {
			const id = assertSnowflake(eventId, 'event_id');
			const guild = ctx.getGuild();
			const event = await guild.scheduledEvents.fetch(id).catch(() => null);
			await ctx.guardGuild(guild, ['ManageEvents'], 'delete an event');
			if (!event) throw new DiscordError(`event ${id} not found`);
			return await event.delete();
		},

		// ----- members -----
		get_member: async (memberId: string) => {
			const guild = ctx.getGuild();
			const m = await fetchMember(guild, memberId, 'read');
			return {
				id: m.id,
				username: m.user.username,
				display_name: m.displayName,
				is_owner: m.id === guild.ownerId,
				is_bot: m.user.bot === true,
				roles: m.roles.cache.map((r) => r.name).filter((n) => n !== '@everyone'),
				top_role_position: m.roles.highest.position,
				joined_at: m.joinedAt ? m.joinedAt.toISOString() : '',
				timeout_until: m.communicationDisabledUntil ? m.communicationDisabledUntil.toISOString() : ''
			};
		},
		kick_member: async (memberId: string, reason?: string) => await moderate(memberId, 'kick', ['KickMembers']).then((m) => m.kick(sanitizeReason(reason))),
		ban_member: async (memberId: string, reason?: string) => {
			const id = assertSnowflake(memberId, 'member_id');
			const guild = ctx.getGuild();
			const me = await ctx.guardGuild(guild, ['BanMembers'], 'ban a member');
			// banning someone who already left is legal: hierarchy only exists
			// while they are still a member
			const member = await guild.members.fetch(id).catch(() => null);
			if (member) assertCanActOn(selfFacts(me, guild), memberFacts(member, guild), 'ban');
			return await guild.members.ban(id, { reason: sanitizeReason(reason) });
		},
		unban_member: async (memberId: string, reason?: string) => {
			const id = assertSnowflake(memberId, 'member_id');
			const guild = ctx.getGuild();
			await ctx.guardGuild(guild, ['BanMembers'], 'unban a member');
			return await guild.members.unban(id, sanitizeReason(reason));
		},
		timeout_member: async (memberId: string, durationSeconds: number, reason?: string) => {
			const seconds = assertTimeoutSeconds(durationSeconds);
			const member = await moderate(memberId, 'timeout', ['ModerateMembers']);
			return await member.timeout(seconds * 1000, sanitizeReason(reason));
		},
		untimeout_member: async (memberId: string, reason?: string) => {
			const member = await moderate(memberId, 'untimeout', ['ModerateMembers']);
			return await member.timeout(null, sanitizeReason(reason));
		},
		grant_role: async (memberId: string, roleId: string, reason?: string) => {
			const rid = assertSnowflake(roleId, 'role_id');
			const mid = assertSnowflake(memberId, 'member_id');
			const guild = ctx.getGuild();
			const role = await fetchRole(guild, rid);
			const me = await ctx.guardGuild(guild, ['ManageRoles'], 'grant a role');
			assertCanManageRole(me.roles.highest.position, role, guild.id, 'grant');
			const member = await fetchMember(guild, mid, 'grant a role');
			// Discord also enforces hierarchy against the TARGET member
			assertHierarchy(selfFacts(me, guild), memberFacts(member, guild), 'grant a role to');
			return await member.roles.add(role.id, sanitizeReason(reason));
		},
		revoke_role: async (memberId: string, roleId: string, reason?: string) => {
			const rid = assertSnowflake(roleId, 'role_id');
			const mid = assertSnowflake(memberId, 'member_id');
			const guild = ctx.getGuild();
			const role = await fetchRole(guild, rid);
			const me = await ctx.guardGuild(guild, ['ManageRoles'], 'revoke a role');
			assertCanManageRole(me.roles.highest.position, role, guild.id, 'revoke');
			const member = await fetchMember(guild, mid, 'revoke a role');
			assertHierarchy(selfFacts(me, guild), memberFacts(member, guild), 'revoke a role from');
			return await member.roles.remove(role.id, sanitizeReason(reason));
		},
		has_role: async (memberId: string, roleId: string) => {
			const rid = assertSnowflake(roleId, 'role_id');
			const guild = ctx.getGuild();
			const member = await fetchMember(guild, memberId, 'has_role');
			return member.roles.cache.has(rid);
		}
	};
}
