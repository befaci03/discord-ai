/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// Guards for the discord builtin: permission, hierarchy and payload checks that
// run BEFORE the discord.js call.
//
// Discord stays the final authority, but a raw 50013 "Missing Permissions"
// tells the model nothing. Each guard throws a DiscordError naming exactly what
// is missing, so a tool call can be corrected instead of blindly retried.
// Everything below is pure (no client, no network) and unit-testable with plain
// objects; makeCtx() is the only piece that touches a client.

import type { Client as DiscordClient, Guild, GuildMember, PresenceData } from 'discord.js';
import { isHostAllowed } from '../netguard.js';

export class DiscordError extends Error {
	constructor(message: string) {
		super(`Runtime error: ${message}`);
		this.name = 'RuntimeError';
	}
}

/** The subset of discord.js PermissionsBitField the guards need. */
export interface PermView {
	has(permission: string): boolean;
}

/**
 * Missing permissions out of `need`. `null` means "no permission model here"
 * (a DM, a partial channel): nothing to check, the API still decides.
 */
export function missingPerms(view: PermView | null | undefined, need: string[]): string[] {
	if (!view) return [];
	// Administrator implies everything, whatever the view is built from
	if (view.has('Administrator')) return [];
	return need.filter((p) => !view.has(p));
}

/** Throws when any of `need` is missing (an Administrator holds them all). */
export function requirePerms(view: PermView | null | undefined, need: string[], what: string): void {
	const missing = missingPerms(view, need);
	if (missing.length > 0) throw new DiscordError(`missing permission ${missing.join(', ')} to ${what}`);
}

/** Throws unless at least one of `options` is held (CREATE_X OR MANAGE_X ...). */
export function requireAnyPerm(view: PermView | null | undefined, options: string[], what: string): void {
	if (!view) return;
	if (!options.some((p) => view.has(p))) throw new DiscordError(`missing permission (one of ${options.join(', ')}) to ${what}`);
}

/** What a hierarchy check knows about a guild member. */
export interface MemberFacts {
	id: string;
	/** position of the member's highest role */
	topRolePos: number;
	/** the guild's owner id */
	ownerId: string;
}

/**
 * Role hierarchy only: the target's highest role must sit BELOW ours. Both at
 * @everyone (position 0) is left to the API, where the rule is ambiguous and a
 * false refusal here would block a legitimate action.
 */
export function assertHierarchy(actor: MemberFacts, target: MemberFacts, what: string): void {
	if (target.topRolePos === 0 && actor.topRolePos === 0) return;
	if (target.topRolePos >= actor.topRolePos) {
		throw new DiscordError(`cannot ${what} a member whose top role (position ${target.topRolePos}) is not below yours (position ${actor.topRolePos})`);
	}
}

/** Moderation adds two more rules: never yourself, never the server owner. */
export function assertCanActOn(actor: MemberFacts, target: MemberFacts, what: string): void {
	if (target.id === actor.id) throw new DiscordError(`cannot ${what} yourself`);
	if (target.id === actor.ownerId) throw new DiscordError(`cannot ${what} the server owner`);
	assertHierarchy(actor, target, what);
}

/** Facts for the bot itself. */
export function selfFacts(me: GuildMember, guild: Guild): MemberFacts {
	return { id: me.id, topRolePos: me.roles?.highest?.position ?? 0, ownerId: guild.ownerId };
}

/** Facts for an arbitrary member of the guild. */
export function memberFacts(member: GuildMember, guild: Guild): MemberFacts {
	return { id: member.id, topRolePos: member.roles?.highest?.position ?? 0, ownerId: guild.ownerId };
}

/**
 * Can the bot touch this role? @everyone (the guild's own id), integration
 * managed roles and anything at or above the bot's highest role are refused.
 */
export function assertCanManageRole(actorTopRolePos: number, role: { id: string; position: number; managed?: boolean; name?: string }, guildId: string, what: string): void {
	if (role.id === guildId) throw new DiscordError(`cannot ${what} the @everyone role`);
	if (role.managed === true) throw new DiscordError(`cannot ${what} role '${role.name ?? role.id}': it is managed by an integration`);
	if (role.position >= actorTopRolePos) {
		throw new DiscordError(`cannot ${what} role '${role.name ?? role.id}' (position ${role.position}): your top role is at ${actorTopRolePos}`);
	}
}

/** Discord ids are 17-20 digit snowflakes: reject junk before it hits the API. */
export function assertSnowflake(id: unknown, what: string): string {
	const s = typeof id === 'string' ? id.trim() : '';
	if (!/^\d{17,20}$/.test(s)) throw new DiscordError(`${what} must be a Discord id (17-20 digits), got '${String(id ?? '').slice(0, 40)}'`);
	return s;
}

/** Discord timeouts run from 1 second to 28 days. */
export function assertTimeoutSeconds(seconds: unknown): number {
	if (typeof seconds !== 'number' || !Number.isFinite(seconds)) throw new DiscordError('timeout_member: duration_seconds must be a number (seconds)');
	const s = Math.round(seconds);
	if (s < 1 || s > 2_419_200) throw new DiscordError('timeout_member: duration_seconds must be between 1 and 2419200 (28 days)');
	return s;
}

/** Audit reasons are capped at 512 chars by Discord; empty means "no reason". */
export function sanitizeReason(reason: unknown): string | undefined {
	const s = typeof reason === 'string' ? reason.trim() : '';
	if (s.length === 0) return undefined;
	return s.slice(0, 512);
}

/** Discord rejects message content over 2000 characters. */
export function assertMessageContent(content: unknown): string {
	const s = typeof content === 'string' ? content : String(content ?? '');
	if (s.length > 2000) throw new DiscordError(`message content too long (${s.length} > 2000 chars)`);
	return s;
}

/** Reactions are unicode text, ':name:' or '<:name:id>' - nothing else. */
export function assertEmoji(emoji: unknown): string {
	const s = typeof emoji === 'string' ? emoji.trim() : '';
	if (s.length === 0 || s.length > 64) throw new DiscordError("emoji must be 1..64 chars (unicode emoji, ':name:' or '<:name:id>')");
	return s;
}

/**
 * discord.js resolves emoji/sticker/soundboard uploads with resolveFile(),
 * which FETCHES http(s) urls from this process and treats anything else as a
 * LOCAL FILE PATH. Model input therefore only ever reaches it as an https URL
 * to a public host: no file paths, no loopback/private ranges (SSRF).
 */
export function assertRemoteImageUrl(raw: unknown, what: string): string {
	const s = typeof raw === 'string' ? raw.trim() : '';
	if (s.length === 0 || s.length > 2_000 || !s.startsWith('https://')) throw new DiscordError(`${what}: image_url must be a https URL (no file paths)`);
	let host: string;
	try {
		host = new URL(s).hostname.toLowerCase();
	} catch {
		throw new DiscordError(`${what}: image_url is not a valid URL`);
	}
	if (!isHostAllowed(host, { blockPrivate: true })) throw new DiscordError(`${what}: host '${host.slice(0, 100)}' is not allowed`);
	return s;
}

export const PRESENCE_STATUSES = ['online', 'idle', 'dnd', 'invisible'] as const;

/** Bots cannot set a Custom (4) status: user accounts only. */
const ACTIVITY_TYPES: Record<string, number> = { playing: 0, streaming: 1, listening: 2, watching: 3, competing: 5 };
const STREAM_URL = /^https:\/\/(www\.)?(twitch\.tv|youtube\.com|youtu\.be)\//i;

/**
 * Validate a presence request and build the setPresence payload.
 * status: online/idle/dnd/invisible. type: playing/streaming/listening/
 * watching/competing, or "" to clear the activity. Text is capped at 128 chars
 * (Discord's own cap) and streaming needs a twitch/youtube url.
 */
export function buildPresence(status: unknown, type: unknown, text: unknown, url: unknown): PresenceData {
	const st = String(status ?? '')
		.trim()
		.toLowerCase();
	if (st === '') return buildPresence('online', type, text, url); // optional arg: online
	if (!(PRESENCE_STATUSES as readonly string[]).includes(st)) throw new DiscordError(`set_presence: status must be one of ${PRESENCE_STATUSES.join(', ')}`);
	const kind = String(type ?? '')
		.trim()
		.toLowerCase();
	const name = String(text ?? '');
	if (name.length > 128) throw new DiscordError('set_presence: activity text too long (max 128 chars)');
	if (kind !== '' && name.length === 0) throw new DiscordError('set_presence: an activity type needs a text');
	if (kind === '' && name.length > 0) throw new DiscordError(`set_presence: activity text needs a type (${Object.keys(ACTIVITY_TYPES).join(', ')})`);
	if (kind === '') return { status: st, activities: [] } as unknown as PresenceData;
	const activityType = ACTIVITY_TYPES[kind];
	if (activityType === undefined) throw new DiscordError(`set_presence: unknown activity type '${kind}' (allowed: ${Object.keys(ACTIVITY_TYPES).join(', ')})`);
	if (kind === 'streaming') {
		const u = String(url ?? '').trim();
		if (!STREAM_URL.test(u)) throw new DiscordError('set_presence: streaming needs a twitch.tv or youtube.com url as the 4th argument');
		return { status: st, activities: [{ type: activityType, name, url: u }] } as unknown as PresenceData;
	}
	return { status: st, activities: [{ type: activityType, name }] } as unknown as PresenceData;
}

export interface DiscordCtx {
	/** the guild this deployment lives in (single-server by design) */
	getGuild(): Guild;
	/** the bot's member in a guild; null when it cannot be resolved */
	botMember(guild: Guild): Promise<GuildMember | null>;
	/** same, but a failure is an error: callers need it to verify anything */
	requireMe(guild: Guild, what: string): Promise<GuildMember>;
	/** the bot's own user id, null before the client is ready */
	botId(): string | null;
	/** guild-wide permission view (channel overwrites do not apply) */
	guildView(me: GuildMember | null): PermView | null;
	/** channel permission view; null = no model to check (DM / partial) */
	channelView(channel: unknown, me: GuildMember | null): PermView | null;
	/** pre-check a guild-wide permission; returns the bot member used */
	guardGuild(guild: Guild, need: string[], what: string): Promise<GuildMember>;
	/** pre-check a channel permission; skips when the channel has no model */
	guardChannel(channel: unknown, need: string[], what: string): Promise<void>;
	/** same, but one of the permissions is enough */
	guardChannelAny(channel: unknown, options: string[], what: string): Promise<void>;
}

/** Client-bound glue for the guards, shared by discord.ts and discordmanage.ts. */
export function makeCtx(getClient: () => DiscordClient): DiscordCtx {
	const getGuild = (): Guild => {
		const guild = getClient().guilds.cache.first();
		if (!guild) throw new DiscordError('no guild found');
		return guild;
	};
	const botMember = async (guild: Guild): Promise<GuildMember | null> => {
		const cached = guild.members?.me ?? null;
		if (cached) return cached;
		try {
			return await guild.members.fetchMe();
		} catch {
			return null;
		}
	};
	const requireMe = async (guild: Guild, what: string): Promise<GuildMember> => {
		const me = await botMember(guild);
		if (!me) throw new DiscordError(`cannot verify permissions to ${what}: the bot member is not available in this guild`);
		return me;
	};
	const botId = (): string | null => getClient().user?.id ?? null;
	const guildView = (me: GuildMember | null): PermView | null => (me ? (me.permissions as unknown as PermView) : null);
	const channelView = (channel: unknown, me: GuildMember | null): PermView | null => {
		if (!me) return null;
		const ch = channel as { guild?: unknown; permissionsFor?: (m: unknown) => PermView | null } | null;
		// DMs and partials have no permission model: nothing to pre-check
		if (!ch?.guild || typeof ch.permissionsFor !== 'function') return null;
		try {
			return ch.permissionsFor(me) ?? null;
		} catch {
			return null;
		}
	};
	const guardGuild = async (guild: Guild, need: string[], what: string): Promise<GuildMember> => {
		const me = await requireMe(guild, what);
		requirePerms(guildView(me), need, what);
		return me;
	};
	const guardChannel = async (channel: unknown, need: string[], what: string): Promise<void> => {
		const guild = (channel as { guild?: Guild } | null)?.guild ?? null;
		if (!guild) return;
		const me = await botMember(guild);
		if (!me) return; // unverifiable here: the API still enforces
		requirePerms(channelView(channel, me), need, what);
	};
	const guardChannelAny = async (channel: unknown, options: string[], what: string): Promise<void> => {
		const guild = (channel as { guild?: Guild } | null)?.guild ?? null;
		if (!guild) return;
		const me = await botMember(guild);
		if (!me) return;
		requireAnyPerm(channelView(channel, me), options, what);
	};
	return { getGuild, botMember, requireMe, botId, guildView, channelView, guardGuild, guardChannel, guardChannelAny };
}
