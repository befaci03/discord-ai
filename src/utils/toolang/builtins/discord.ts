/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.

import type { Client as DiscordClient } from "discord.js";

class DiscordError extends Error {
	constructor(message: string) {
		super(`Runtime error: ${message}`);
		this.name = "RuntimeError";
	}
}

export function Discord(getClient: () => DiscordClient): Record<string, Function> {
	const findChannel = async (id: string, type?: "text" | "voice" | "category") => {
		const ch = await getClient().channels.fetch(id);
		if (type === "text" && (!ch || !ch.isTextBased() || !("send" in ch))) throw new DiscordError(`channel ${id} not found or not text-based`);
		if (type === "voice" && (!ch || !ch.isVoiceBased() || !("join" in ch))) throw new DiscordError(`channel ${id} not found or not voice-based`);
		if (type === "category" && (!ch || ch.isSendable())) throw new DiscordError(`channel ${id} not found or not a category`);
		return ch;
	}
	const findMessage = async (messageId: string) => {
		const client = getClient();
		const channels = client.channels.cache.values();
		for (const ch of channels) {
			if (!ch.isTextBased() || !("messages" in ch)) continue;
			try { return await (ch as any).messages.fetch(messageId) } catch { continue }
		}
		throw new DiscordError(`message ${messageId} not found`);
	}
	const getGuild = () => {
		const guild = getClient().guilds.cache.first();
		if (!guild) throw new DiscordError("no guild found");
		return guild;
	}

	return {
		make_embed: (data: Record<string, unknown>, components?: unknown[]) => ({ embeds: [data], components: components ?? [] }),
		make_attachment: (data: Record<string, unknown>) => data,

		send_message: async (channelId: string, content: string, options?: Record<string, unknown>) => {
			const client = getClient();
			const ch = await client.channels.fetch(channelId);
			if (!ch) throw new DiscordError("no text channel found");
			const payload: Record<string, unknown> = { content }
			if (options?.embeds) payload.embeds = options.embeds;
			if (options?.attachments) payload.attachments = options.attachments;
			return await (ch as any).send(payload);
		},
		reply: async (messageId: string, content: string, options?: Record<string, unknown>) => {
			const msg = await findMessage(messageId);
			const payload: Record<string, unknown> = { content }
			if (options?.embeds) payload.embeds = options.embeds;
			return await msg.reply(payload);
		},

		react: async (messageId: string, emoji: string) => await (await findMessage(messageId)).react(emoji),
		delete_reaction: async (messageId: string, emoji: string) => await (await findMessage(messageId)).reactions.cache.get(emoji)?.remove(),

		edit_message: async (messageId: string, content: string, options?: Record<string, unknown>) => {
			const msg = await findMessage(messageId);
			const payload: Record<string, unknown> = { content }
			if (options?.embeds) payload.embeds = options.embeds;
			if (options?.attachments) payload.attachments = options.attachments;
			return await msg.edit(payload);
		},
		delete_message: async (messageId: string) => await (await findMessage(messageId)).delete(),
		get_message: async (messageId: string) => await findMessage(messageId),
		send_poll: async (channelId: string, title: string, options: { label: string; emoji?: string }[], durationHours: number) => {
			const ch = await getClient().channels.fetch(channelId);
			if (!ch) throw new DiscordError("no text channel found");
			return await (ch as any).send({
				poll: {
					question: { text: title },
					answers: options.map((o) => ({
						answer_data: { text: o.label },
						emoji: o.emoji ? { name: o.emoji } : undefined
					})),
					duration: durationHours
				}
			});
		},
		send_sticker: async (channelId: string, stickerId: string) => {
			const ch = await getClient().channels.fetch(channelId);
			if (!ch) throw new DiscordError("no text channel found");
			return await (ch as any).send({ stickerIds: [stickerId] });
		},

		get_server_emojis: async () => await getGuild().emojis.fetch(),
		create_emoji: async (name: string, imageUrl: string) => await getGuild().emojis.create({ attachment: imageUrl, name }),
		edit_emoji: async (emojiId: string, newName: string) => {
			const emoji = await getGuild().emojis.fetch(emojiId);
			if (!emoji) throw new DiscordError("emoji not found");
			return await emoji.edit({ name: newName });
		},
		delete_emoji: async (emojiId: string) => {
			const emoji = await getGuild().emojis.fetch(emojiId);
			if (!emoji) throw new DiscordError("emoji not found");
			return await emoji.delete();
		},

		get_server_stickers: async () => await getGuild().stickers.fetch(),
		create_sticker: async (name: string, imageUrl: string) => await getGuild().stickers.create({ name, file: imageUrl, tags: name }),
		edit_sticker: async (stickerId: string, newName: string) => {
			const sticker = await getGuild().stickers.fetch(stickerId);
			if (!sticker) throw new DiscordError("sticker not found");
			return await sticker.edit({ name: newName });
		},
		delete_sticker: async (stickerId: string) => {
			const sticker = await getGuild().stickers.fetch(stickerId);
			if (!sticker) throw new DiscordError("sticker not found");
			return await sticker.delete();
		},

		get_server_soundboards: async () => {
			return await (getGuild() as any).soundboardSounds?.fetch();
		},
		create_soundboard: async (name: string, audioUrl: string) => {
			return await (getGuild() as any).soundboardSounds?.create({ name, file: audioUrl });
		},
		delete_soundboard: async (soundId: string) => {
			const sound = await (getGuild() as any).soundboardSounds?.fetch(soundId);
			if (!sound) throw new DiscordError("soundboard not found");
			return await sound?.delete();
		},

		get_all_channels: async () => {
			return await getGuild().channels.fetch();
		},
		create_channel: async (name: string, type?: string) => {
			const channelType =
				type === "announcement" ? 5 : type === "voice" ? 2 : 0;
			return await getGuild().channels.create({
				name,
				type: channelType as any,
			});
		},
		duplicate_channel: async (channelId: string, newName?: string) => {
			const client = getClient();
			const ch = await client.channels.fetch(channelId);
			if (!ch) throw new DiscordError(`channel ${channelId} not found`);
			return await getGuild().channels.create({
				name: newName ?? `${(ch as any).name ?? "channel"}-copy`,
				type: ch.type as any,
				topic: "topic" in ch ? (ch as any).topic : undefined
			});
		},
		recreate_channel: async (channelId: string) => {
			const client = getClient();
			const ch = await client.channels.fetch(channelId);
			if (!ch) throw new DiscordError(`channel ${channelId} not found`);

			const chName = (ch as any).name ?? "channel";
			const chType = ch.type;
			const topic = "topic" in ch ? (ch as any).topic : undefined;

			const newCh = await getGuild().channels.create({ name: chName, type: chType as any, topic });
			await ch.delete();
			return newCh;
		},
		edit_channel: async (channelId: string, data: Record<string, unknown>) => {
			const ch = await getClient().channels.fetch(channelId);
			if (!ch) throw new DiscordError(`channel ${channelId} not found`);
			if ("edit" in ch) return await (ch as any).edit(data);
			throw new DiscordError(`channel ${channelId} is not editable`);
		},
		delete_channel: async (channelId: string) => {
			const ch = await getClient().channels.fetch(channelId);
			if (!ch) throw new DiscordError(`channel ${channelId} not found`);
			return await ch.delete();
		},
		get_channel: async (channelId: string) => {
			const ch = await getClient().channels.fetch(channelId);
			if (!ch) throw new DiscordError(`channel ${channelId} not found`);
			return ch;
		},
		channel_exists: async (channelId: string) => {
			const ch = await getClient().channels.fetch(channelId);
			return ch !== null;
		},

		create_thread: async (channelId: string, name: string, messageId?: string) => {
			const ch = await getClient().channels.fetch(channelId);
			if (!ch || !("threads" in ch)) throw new DiscordError(`channel ${channelId} does not support threadsor doesnt exist`);
			if (messageId) return await (ch as any).threads.create({ name, startMessage: messageId });
			return await (ch as any).threads.create({ name });
		},
		edit_thread: async (threadId: string, data: Record<string, unknown>) => {
			const ch = await getClient().channels.fetch(threadId);
			if (!ch || !("edit" in ch)) throw new DiscordError(`thread ${threadId} not found`);
			return await (ch as any).edit(data);
		},
		delete_thread: async (threadId: string) => {
			const ch = await getClient().channels.fetch(threadId);
			if (!ch) throw new DiscordError(`thread ${threadId} not found`);
			return await ch.delete();
		},

		create_category: async (name: string) => await getGuild().channels.create({ name, type: 4 as any }),
		edit_category: async (categoryId: string, data: Record<string, unknown>) => {
			const ch = await getClient().channels.fetch(categoryId);
			if (!ch || !("edit" in ch)) throw new DiscordError(`category ${categoryId} not found`);
			return await (ch as any).edit(data);
		},
		delete_category: async (categoryId: string) => {
			const ch = await getClient().channels.fetch(categoryId);
			if (!ch) throw new DiscordError(`category ${categoryId} not found`);
			return await ch.delete();
		},

		get_all_roles: async () => await getGuild().roles.fetch(),
		create_role: async (data: Record<string, unknown>) => await getGuild().roles.create(data as any),
		edit_role: async (roleId: string, data: Record<string, unknown>) => {
			const role = await getGuild().roles.fetch(roleId);
			if (!role) throw new DiscordError(`role ${roleId} not found`);
			return await role.edit(data as any);
		},
		delete_role: async (roleId: string) => {
			const role = await getGuild().roles.fetch(roleId);
			if (!role) throw new DiscordError(`role ${roleId} not found`);
			return await role.delete();
		},

		list_scheduled_events: async () => await getGuild().scheduledEvents.fetch(),
		schedule_event: async (name: string, description: string, where: { type: string; value: string }, coverUrl?: string) => {
			const data: Record<string, unknown> = { name, description, scheduledStartTime: where.value, scheduledEndTime: where.value }
			if (where.type === "voice" || where.type === "text") data.channel = where.value;
			else {
				// i kinda asked chatgpt for that ('^^)
				data.entityType = 3; // External
				data.entityMetadata = { location: where.value };
			}
			if (coverUrl) data.image = coverUrl;
			return await getGuild().scheduledEvents.create(data as any);
		},
		edit_event: async (eventId: string, data: Record<string, unknown>, coverUrl?: string) => {
			const event = await getGuild().scheduledEvents.fetch(eventId);
			if (!event) throw new DiscordError(`event ${eventId} not found`);
			const editData: Record<string, unknown> = { ...data }
			if (coverUrl) editData.image = coverUrl;
			return await event.edit(editData as any);
		},
		delete_event: async (eventId: string) => {
			const event = await getGuild().scheduledEvents.fetch(eventId);
			if (!event) throw new DiscordError(`event ${eventId} not found`);
			return await event.delete();
		},

		kick_member: async (memberId: string, reason?: string) => {
			const member = await getGuild().members.fetch(memberId);
			if (!member) throw new DiscordError(`member ${memberId} not found`);
			return await member.kick(reason);
		},
		ban_member: async (memberId: string, reason?: string) => await getGuild().members.ban(memberId, { reason }),
		unban_member: async (memberId: string, reason?: string) => await getGuild().members.unban(memberId, reason),
		timeout_member: async (memberId: string, durationSeconds: number, reason?: string) => {
			const member = await getGuild().members.fetch(memberId);
			if (!member) throw new DiscordError(`member ${memberId} not found`);
			return await member.timeout(durationSeconds * 1000, reason);
		},
		untimeout_member: async (memberId: string, reason?: string) => {
			const member = await getGuild().members.fetch(memberId);
			if (!member) throw new DiscordError(`member ${memberId} not found`);
			return await member.timeout(null, reason);
		},

		grant_role: async (memberId: string, roleId: string, reason?: string) => {
			const member = await getGuild().members.fetch(memberId);
			if (!member) throw new DiscordError(`member ${memberId} not found`);
			return await member.roles.add(roleId, reason);
		},
		revoke_role: async (memberId: string, roleId: string, reason?: string) => {
			const member = await getGuild().members.fetch(memberId);
			if (!member) throw new DiscordError(`member ${memberId} not found`);
			return await member.roles.remove(roleId, reason);
		},
		has_role: async (memberId: string, roleId: string) => {
			const member = await getGuild().members.fetch(memberId);
			if (!member) throw new DiscordError(`member ${memberId} not found`);
			return member.roles.cache.has(roleId);
		},
	};
}
