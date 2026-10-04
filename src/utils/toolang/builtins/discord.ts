/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// Discord builtin for TooLang: messages, reactions, presence and embeds.
// Guild management (members, roles, channels, expressions, events) lives in
// discordmanage.ts, the permission/hierarchy guards in discordguard.ts.

import type { Client as DiscordClient } from 'discord.js';
import { DiscordError, makeCtx, requirePerms, assertSnowflake, assertMessageContent, assertEmoji, buildPresence } from './discordguard.js';
import { Manage } from './discordmanage.js';

/** model output must never ping anyone: no @everyone/@here/roles/users */
const NO_PINGS = { parse: [] };

/** the two permission shapes Discord distinguishes for sending */
const SEND_PERMS = ['SendMessages', 'SendMessagesInThreads'];

export function Discord(getClient: () => DiscordClient): Record<string, Function> {
	const ctx = makeCtx(getClient);

	/**
	 * message id -> channel id. Without it every lookup probes every cached
	 * channel (N REST fetches per edit/delete/get); with it a repeated lookup
	 * is one call. Bounded FIFO: old entries fall off first.
	 */
	const msgChannel = new Map<string, string>();
	const rememberChannel = (messageId: string, channelId: string): void => {
		if (msgChannel.size >= 500) msgChannel.delete(msgChannel.keys().next().value as string);
		msgChannel.set(messageId, channelId);
	};
	const findMessage = async (messageId: string): Promise<any> => {
		const id = assertSnowflake(messageId, 'message_id');
		// fast path: we have fetched this message before, ask that channel only
		const cachedChannel = msgChannel.get(id);
		if (cachedChannel) {
			try {
				const ch = await getClient().channels.fetch(cachedChannel);
				if (ch && 'messages' in ch) return await (ch as any).messages.fetch(id);
			} catch {
				/* stale entry: fall through to the scan */
			}
			msgChannel.delete(id);
		}
		const channels = getClient().channels.cache.values();
		for (const ch of channels) {
			if (!ch.isTextBased() || !('messages' in ch)) continue;
			try {
				const msg = await (ch as any).messages.fetch(id);
				rememberChannel(id, ch.id);
				return msg;
			} catch {
				continue;
			}
		}
		throw new DiscordError(`message ${id} not found`);
	};
	/** resolve a reaction whatever emoji format the model used */
	const findReaction = (msg: any, emoji: string): any => {
		const mgr = msg?.reactions;
		if (!mgr) return null;
		const resolved = typeof mgr.resolve === 'function' ? mgr.resolve(emoji) : null;
		if (resolved) return resolved;
		if (typeof mgr.cache?.get === 'function') {
			const direct = mgr.cache.get(emoji);
			if (direct) return direct;
			// '<:name:id>' / '<a:name:id>' carry the id the cache is keyed by
			const custom = /^<a?:[a-zA-Z0-9_]+:(\d{17,20})>$/.exec(emoji);
			if (custom) {
				const byId = mgr.cache.get(custom[1]);
				if (byId) return byId;
			}
			return [...mgr.cache.values()].find((r: any) => r?.emoji?.name === emoji) ?? null;
		}
		return null;
	};
	/** payload builder: content + optional embeds/attachments, never pings */
	const payloadOf = (content: string, options?: Record<string, unknown>): Record<string, unknown> => {
		const body: Record<string, unknown> = { content: assertMessageContent(content), allowedMentions: NO_PINGS };
		if (options?.embeds) body.embeds = options.embeds;
		if (options?.attachments) body.attachments = options.attachments;
		return body;
	};
	/** a message needs something to show: content, an embed or an attachment */
	const requireBody = (body: Record<string, unknown>): void => {
		if (String(body.content ?? '').length === 0 && !body.embeds && !body.attachments) {
			throw new DiscordError('a message needs content, an embed or an attachment');
		}
	};
	/** fetch a channel that can be posted to, or fail with a clear error */
	const fetchSendable = async (channelId: string, what: string): Promise<any> => {
		const id = assertSnowflake(channelId, 'channel_id');
		const ch = await getClient()
			.channels.fetch(id)
			.catch(() => null);
		if (!ch || !('send' in ch)) throw new DiscordError(`channel ${id} not found or not sendable (${what})`);
		return ch;
	};

	const core: Record<string, Function> = {
		make_embed: (data: Record<string, unknown>, components?: unknown[]) => ({ embeds: [data], components: components ?? [] }),
		make_attachment: (data: Record<string, unknown>) => data,

		send_message: async (channelId: string, content: string, options?: Record<string, unknown>) => {
			const payload = payloadOf(content, options);
			requireBody(payload);
			const ch = await fetchSendable(channelId, 'send a message');
			await ctx.guardChannelAny(ch, SEND_PERMS, 'send a message');
			return await (ch as any).send(payload);
		},
		reply: async (messageId: string, content: string, options?: Record<string, unknown>) => {
			const payload = payloadOf(content, options);
			requireBody(payload);
			const msg = await findMessage(messageId);
			await ctx.guardChannelAny(msg?.channel, SEND_PERMS, 'reply to a message');
			return await msg.reply(payload);
		},

		// ----- editing: Discord only lets the author edit, so only our own
		// messages are editable (a clear error instead of a raw 40033) -----
		edit_message: async (messageId: string, content: string, options?: Record<string, unknown>) => {
			const payload = payloadOf(content, options);
			requireBody(payload);
			const msg = await findMessage(messageId);
			const botId = ctx.botId();
			if (!botId) throw new DiscordError('client is not ready (no user)');
			if (msg?.author?.id !== botId) throw new DiscordError(`message ${messageId} was not sent by this bot: only your own messages can be edited`);
			return await msg.edit(payload);
		},
		/** edit this bot's newest message in a channel (no id needed) */
		edit_last_message: async (channelId: string, content: string, options?: Record<string, unknown>) => {
			const payload = payloadOf(content, options);
			requireBody(payload);
			const id = assertSnowflake(channelId, 'channel_id');
			const botId = ctx.botId();
			if (!botId) throw new DiscordError('client is not ready (no user)');
			const ch = await getClient()
				.channels.fetch(id)
				.catch(() => null);
			if (!ch || !('messages' in ch)) throw new DiscordError(`channel ${id} has no messages`);
			const recent = await (ch as any).messages.fetch({ limit: 25 }).catch(() => null);
			const mine = recent ? [...recent.values()].find((m: any) => m?.author?.id === botId) : null;
			if (!mine) throw new DiscordError(`no recent message from the bot in channel ${id}: use edit_message with the id`);
			return await mine.edit(payload);
		},
		delete_message: async (messageId: string) => {
			const msg = await findMessage(messageId);
			const botId = ctx.botId();
			if (msg?.author?.id !== botId) {
				// deleting someone else's message is moderation, not bookkeeping
				const guild = msg?.channel?.guild ?? msg?.guild ?? null;
				const me = guild ? await ctx.botMember(guild) : null;
				requirePerms(ctx.channelView(msg?.channel, me), ['ManageMessages'], 'delete a message from another author');
			}
			return await msg.delete();
		},
		get_message: async (messageId: string) => await findMessage(messageId),

		// ----- reactions -----
		react: async (messageId: string, emoji: string) => {
			const e = assertEmoji(emoji);
			const msg = await findMessage(messageId);
			await ctx.guardChannel(msg?.channel, ['AddReactions'], 'react to a message');
			return await msg.react(e);
		},
		/** drop ONE user's reaction (defaults to our own: no permission needed) */
		remove_reaction: async (messageId: string, emoji: string, userId?: string) => {
			const e = assertEmoji(emoji);
			const msg = await findMessage(messageId);
			const reaction = findReaction(msg, e);
			if (!reaction) throw new DiscordError(`no '${e}' reaction on message ${messageId}`);
			const botId = ctx.botId();
			if (!botId) throw new DiscordError('client is not ready (no user)');
			const target = userId ? assertSnowflake(userId, 'user_id') : botId;
			if (target !== botId) {
				await ctx.guardChannel(msg?.channel, ['ManageMessages'], "remove another user's reaction");
			}
			return await reaction.users.remove(target);
		},
		/** clear an emoji's reactions from EVERYONE: moderation */
		delete_reaction: async (messageId: string, emoji: string) => {
			const e = assertEmoji(emoji);
			const msg = await findMessage(messageId);
			const reaction = findReaction(msg, e);
			if (!reaction) throw new DiscordError(`no '${e}' reaction on message ${messageId}`);
			await ctx.guardChannel(msg?.channel, ['ManageMessages'], 'clear a reaction from a message');
			return await reaction.remove();
		},

		send_poll: async (channelId: string, title: string, options: { label: string; emoji?: string }[], durationHours: number) => {
			const question = String(title ?? '').trim();
			if (question.length === 0 || question.length > 300) throw new DiscordError('send_poll: title must be 1..300 chars');
			if (!Array.isArray(options) || options.length < 2 || options.length > 10) throw new DiscordError('send_poll: needs 2..10 answers');
			for (const [i, o] of options.entries()) {
				if (String(o?.label ?? '').trim().length === 0) throw new DiscordError(`send_poll: answer ${i + 1} needs a non-empty label`);
			}
			if (typeof durationHours !== 'number' || !Number.isFinite(durationHours) || durationHours < 1 || durationHours > 768) {
				throw new DiscordError('send_poll: duration_hours must be 1..768 (32 days)');
			}
			const ch = await fetchSendable(channelId, 'send a poll');
			await ctx.guardChannelAny(ch, SEND_PERMS, 'send a poll');
			return await (ch as any).send({
				poll: {
					question: { text: question },
					answers: options.map((o) => ({
						answer_data: { text: String(o?.label ?? '').slice(0, 55) },
						emoji: o?.emoji ? { name: o.emoji } : undefined
					})),
					duration: durationHours
				},
				allowedMentions: NO_PINGS
			});
		},
		send_sticker: async (channelId: string, stickerId: string) => {
			const sticker = assertSnowflake(stickerId, 'sticker_id');
			const ch = await fetchSendable(channelId, 'send a sticker');
			await ctx.guardChannelAny(ch, SEND_PERMS, 'send a sticker');
			return await (ch as any).send({ stickerIds: [sticker], allowedMentions: NO_PINGS });
		},

		// ----- presence: status + activity the model can change at runtime -----
		set_presence: (status?: string, activityType?: string, text?: string, url?: string) => {
			const user = getClient().user;
			if (!user) throw new DiscordError('client is not ready (no user)');
			const payload = buildPresence(status, activityType, text, url);
			user.setPresence(payload);
			return { status: payload.status ?? 'online', activities: (payload.activities ?? []).map((a) => ({ type: a.type, name: a.name })) };
		},
		get_presence: () => {
			const presence = getClient().user?.presence;
			return {
				status: presence?.status ?? 'offline',
				activities: (presence?.activities ?? []).map((a) => ({ type: a.type, name: a.name }))
			};
		}
	};

	return { ...core, ...Manage(getClient) };
}
