// The discord builtin's guards and new powers, checked against a MOCK
// Discord.js client (no token in tests): permission pre-checks, role
// hierarchy, own-message editing, reaction removal, presence and the
// guild-management half (members, roles, channels, expressions).
//
// Mocks stay structural: only the members discord.ts/discordmanage.ts actually
// touch exist here, so a refactor that starts using a new API path fails loudly.
// Channel-level and guild-level permissions are tracked separately, because
// discord.js resolves them separately (overwrites vs roles).

import { describe, test, expect } from 'bun:test';
import type { Client as DiscordClient } from 'discord.js';
import { Discord } from '../utils/toolang/builtins/discord.js';
import { runFromSource } from '../utils/toolang/index.js';
import {
	DiscordError,
	missingPerms,
	requirePerms,
	requireAnyPerm,
	assertHierarchy,
	assertCanActOn,
	assertCanManageRole,
	assertSnowflake,
	assertTimeoutSeconds,
	assertMessageContent,
	assertEmoji,
	sanitizeReason,
	buildPresence
} from '../utils/toolang/builtins/discordguard.js';

const BOT_ID = '100000000000000001';
const USER_ID = '100000000000000002';
const OWNER_ID = '100000000000000003';
const MSG_ID = '100000000000000004';
const CHANNEL_ID = '100000000000000005';
const ROLE_ID = '100000000000000006';
const GUILD_ID = '400000000000000001';

/** expect a failure whose message mentions `needle` */
const throws = async (fn: () => unknown, needle: string): Promise<void> => {
	try {
		await fn();
	} catch (err) {
		expect((err as Error).message, `expected an error mentioning '${needle}'`).toContain(needle);
		return;
	}
	throw new Error(`expected a failure mentioning '${needle}'`);
};

const view = (perms: string[]) => ({ has: (p: string) => perms.includes(p) });

/** a guild member with just what the guards and actions read */
function member(id: string, rolePos: number, calls: Record<string, unknown[]> = {}) {
	const rec = (name: string, ...args: unknown[]) => {
		(calls[name] ??= []).push(args);
	};
	return {
		id,
		displayName: 'target',
		user: { id, username: 'target', bot: false },
		joinedAt: new Date('2024-01-01T00:00:00Z'),
		communicationDisabledUntil: null,
		permissions: { has: () => false },
		roles: {
			highest: { position: rolePos },
			cache: {
				has: () => false,
				map: (fn: (r: { name: string }) => unknown) => ['@everyone', 'Members'].map((name) => fn({ name }))
			},
			add: async (roleId: string, reason?: string) => {
				rec('roles.add', roleId, reason);
				return 'added';
			},
			remove: async (roleId: string, reason?: string) => {
				rec('roles.remove', roleId, reason);
				return 'removed';
			}
		},
		kick: async (reason?: string) => {
			rec('kick', reason);
			return 'kicked';
		},
		timeout: async (ms: number | null, reason?: string) => {
			rec('timeout', ms, reason);
			return 'timed';
		}
	};
}

interface GuildOpts {
	ownerId?: string;
	mePerms?: string[];
	meRolePos?: number;
	members?: Record<string, unknown>;
	roles?: Record<string, unknown>;
	calls?: Record<string, unknown[]>;
}

function mockGuild(opts: GuildOpts = {}) {
	const calls = opts.calls ?? {};
	const mePerms = new Set(opts.mePerms ?? []);
	const me = { id: BOT_ID, permissions: { has: (p: string) => mePerms.has(p) }, roles: { highest: { position: opts.meRolePos ?? 5 } } };
	const members: Record<string, unknown> = { [BOT_ID]: me, ...(opts.members ?? {}) };
	const roles: Record<string, unknown> = {
		// @everyone always exists, at position 0
		[GUILD_ID]: { id: GUILD_ID, position: 0, managed: false, name: '@everyone' },
		...(opts.roles ?? {})
	};
	return {
		id: GUILD_ID,
		ownerId: opts.ownerId ?? OWNER_ID,
		calls,
		me,
		/** grant the bot a guild-wide permission in this mock */
		grant: (...perms: string[]) => perms.forEach((p) => mePerms.add(p)),
		members: {
			me,
			fetchMe: async () => me,
			fetch: async (id: string) => {
				if (members[id]) return members[id];
				throw new Error('Unknown Member');
			},
			ban: async (id: string, o: unknown) => {
				(calls.ban ??= []).push([id, o]);
				return { id };
			},
			unban: async (id: string) => {
				(calls.unban ??= []).push([id]);
				return { id };
			}
		},
		roles: {
			fetch: async (id: string) => {
				if (roles[id]) return roles[id];
				throw new Error('Unknown Role');
			}
		},
		channels: {
			create: async (data: Record<string, unknown>) => {
				(calls.channelCreate ??= []).push([data]);
				return { id: '400000000000000099', ...data };
			}
		},
		emojis: {
			create: async (data: Record<string, unknown>) => {
				(calls.emojiCreate ??= []).push([data]);
				return data;
			},
			fetch: async (id: string) => ({ id, edit: async (d: unknown) => d, delete: async () => 'deleted' })
		}
	};
}

interface ReactionEntry {
	emoji?: { name: string };
	users?: { remove: (u: string) => Promise<unknown> };
	remove?: () => Promise<unknown>;
}

/** reaction manager: a Map cache, optionally with resolve() */
function reactions(entries: Record<string, ReactionEntry>, withResolve = true): Record<string, unknown> {
	const cache = new Map<string, ReactionEntry>(Object.entries(entries));
	const mgr: Record<string, unknown> = { cache };
	if (withResolve) mgr.resolve = (e: string) => cache.get(e) ?? null;
	return mgr;
}

interface MsgOpts {
	authorId?: string;
	channel?: unknown;
	reactions?: Record<string, unknown>;
	calls?: Record<string, unknown[]>;
}

function mockMessage(id: string, opts: MsgOpts = {}) {
	const calls = opts.calls ?? {};
	return {
		id,
		author: { id: opts.authorId ?? BOT_ID },
		channel: opts.channel,
		reactions: opts.reactions ?? reactions({}),
		edit: async (payload: Record<string, unknown>) => {
			(calls.edit ??= []).push([payload]);
			return { id, ...payload };
		},
		delete: async () => {
			(calls.delete ??= []).push([true]);
			return 'deleted';
		},
		reply: async (payload: Record<string, unknown>) => {
			(calls.reply ??= []).push([payload]);
			return { id: '400000000000000098', ...payload };
		},
		react: async (emoji: string) => {
			(calls.react ??= []).push([emoji]);
			return { emoji };
		}
	};
}

interface ChannelOpts {
	guild?: unknown;
	perms?: string[];
	byId?: Record<string, unknown>;
	send?: Record<string, unknown[]>;
}

function mockChannel(id: string, opts: ChannelOpts = {}) {
	const perms = new Set(opts.perms ?? []);
	const sendCalls = opts.send ?? {};
	const byId = opts.byId ?? {};
	return {
		id,
		guild: opts.guild ?? null,
		isTextBased: () => true,
		permissionsFor: () => ({ has: (p: string) => perms.has(p) || perms.has('Administrator') }),
		/** grant the bot a channel permission in this mock */
		grant: (...ps: string[]) => ps.forEach((p) => perms.add(p)),
		send: async (payload: Record<string, unknown>) => {
			(sendCalls.sent ??= []).push([payload]);
			return { id: '400000000000000097', author: { id: BOT_ID }, ...payload };
		},
		messages: {
			fetch: async (arg: unknown) => {
				if (typeof arg === 'object' && arg !== null) return new Map(Object.entries(byId));
				const msg = byId[String(arg)];
				if (!msg) throw new Error('Unknown Message');
				return msg;
			}
		}
	};
}

function mockClient(opts: { guild?: unknown; channels?: unknown[]; presence?: { status: string; activities: unknown[] } } = {}) {
	const channels = opts.channels ?? [];
	const state: { payload?: Record<string, unknown> } = {};
	return {
		state,
		user: {
			id: BOT_ID,
			presence: opts.presence ?? { status: 'online', activities: [] },
			setPresence: (p: Record<string, unknown>) => {
				state.payload = p;
				return p;
			}
		},
		guilds: { cache: { first: () => opts.guild ?? null } },
		channels: {
			fetch: async (id: string) => {
				const ch = (channels as { id: string }[]).find((c) => c.id === id);
				if (!ch) throw new Error('Unknown Channel');
				return ch;
			},
			cache: { values: () => channels[Symbol.iterator]() }
		}
	};
}

const mod = (client: unknown): Record<string, Function> => Discord(() => client as DiscordClient);

describe('discord permission guards', () => {
	test('missing permissions are named, and unknown views are skipped', () => {
		expect(missingPerms(view(['SendMessages']), ['SendMessages', 'EmbedLinks'])).toEqual(['EmbedLinks']);
		expect(missingPerms(null, ['KickMembers'])).toEqual([]); // no model (DM) = no pre-check
		expect(() => requirePerms(view([]), ['KickMembers'], 'kick a member')).toThrow(DiscordError);
		expect(() => requirePerms(view([]), ['KickMembers'], 'kick a member')).toThrow('missing permission KickMembers to kick a member');
		expect(() => requirePerms(view(['Administrator']), ['KickMembers'], 'kick')).not.toThrow(); // admin implies all
		expect(() => requireAnyPerm(view(['ManageChannels']), ['CreatePublicThreads', 'ManageChannels'], 'create a thread')).not.toThrow();
		expect(() => requireAnyPerm(view([]), ['CreatePublicThreads', 'ManageChannels'], 'create a thread')).toThrow('one of');
	});

	test('hierarchy: below works, equal/higher does not, @everyone-only is left alone', () => {
		const me = { id: BOT_ID, topRolePos: 5, ownerId: OWNER_ID };
		expect(() => assertHierarchy(me, { id: USER_ID, topRolePos: 3, ownerId: OWNER_ID }, 'timeout')).not.toThrow();
		expect(() => assertHierarchy(me, { id: USER_ID, topRolePos: 5, ownerId: OWNER_ID }, 'timeout')).toThrow('not below yours');
		expect(() => assertHierarchy(me, { id: USER_ID, topRolePos: 9, ownerId: OWNER_ID }, 'timeout')).toThrow('not below yours');
		// both only @everyone: ambiguous, the API decides
		expect(() => assertHierarchy({ ...me, topRolePos: 0 }, { id: USER_ID, topRolePos: 0, ownerId: OWNER_ID }, 'kick')).not.toThrow();
		// moderation adds self + owner rules
		expect(() => assertCanActOn(me, { id: BOT_ID, topRolePos: 1, ownerId: OWNER_ID }, 'kick')).toThrow('yourself');
		expect(() => assertCanActOn(me, { id: OWNER_ID, topRolePos: 1, ownerId: OWNER_ID }, 'ban')).toThrow('server owner');
	});

	test('role reach: @everyone, managed roles and anything above us are refused', () => {
		expect(() => assertCanManageRole(5, { id: GUILD_ID, position: 0 }, GUILD_ID, 'grant')).toThrow('@everyone');
		expect(() => assertCanManageRole(5, { id: ROLE_ID, position: 1, managed: true, name: 'bot-role' }, GUILD_ID, 'grant')).toThrow('managed by an integration');
		expect(() => assertCanManageRole(5, { id: ROLE_ID, position: 5 }, GUILD_ID, 'grant')).toThrow('your top role is at 5');
		expect(() => assertCanManageRole(5, { id: ROLE_ID, position: 4 }, GUILD_ID, 'grant')).not.toThrow();
	});

	test('payload validators reject junk before it reaches the API', () => {
		expect(() => assertSnowflake('nope', 'member_id')).toThrow('17-20 digits');
		expect(() => assertSnowflake('123', 'message_id')).toThrow('message_id');
		expect(assertSnowflake(` ${CHANNEL_ID} `, 'channel_id')).toBe(CHANNEL_ID);

		expect(assertTimeoutSeconds(60)).toBe(60);
		expect(() => assertTimeoutSeconds(0)).toThrow('between 1 and 2419200');
		expect(() => assertTimeoutSeconds(99999999)).toThrow('between 1 and 2419200');
		expect(() => assertTimeoutSeconds('10' as unknown as number)).toThrow('must be a number');

		expect(assertMessageContent('hi')).toBe('hi');
		expect(() => assertMessageContent('x'.repeat(2001))).toThrow('2000 chars');
		expect(assertEmoji('👍')).toBe('👍');
		expect(() => assertEmoji('')).toThrow('1..64');
		expect(sanitizeReason('  why  ')).toBe('why');
		expect(sanitizeReason('')).toBeUndefined();
		expect(sanitizeReason('x'.repeat(600))!.length).toBe(512);
	});
});

describe('discord.set_presence', () => {
	test('builds a validated payload', () => {
		const playing = buildPresence('online', 'playing', 'half-life 3', '') as unknown as { status: string; activities: { type: number; name: string }[] };
		expect(playing.status).toBe('online');
		expect(playing.activities).toEqual([{ type: 0, name: 'half-life 3' }]);

		const stream = buildPresence('dnd', 'streaming', 'speedrun', 'https://twitch.tv/x') as unknown as { activities: { url?: string }[] };
		expect(stream.activities[0]!.url).toBe('https://twitch.tv/x');
		expect((buildPresence('idle', '', '', '') as unknown as { activities: unknown[] }).activities).toEqual([]);

		// status is an optional argument: empty means the default, online
		const bare = buildPresence(undefined, undefined, undefined, undefined) as unknown as { status: string; activities: unknown[] };
		expect(bare.status).toBe('online');
		expect(bare.activities).toEqual([]);
	});

	test('bad status, bad type, over-long text and a missing stream url are refused', () => {
		expect(() => buildPresence('busy', 'playing', 'x', '')).toThrow('status must be one of');
		expect(() => buildPresence('online', 'dancing', 'x', '')).toThrow('unknown activity type');
		expect(() => buildPresence('online', 'playing', 'x'.repeat(129), '')).toThrow('max 128');
		expect(() => buildPresence('online', 'streaming', 'x', 'https://example.com')).toThrow('twitch.tv or youtube.com');
		expect(() => buildPresence('online', '', 'x', '')).toThrow('needs a type');
		expect(() => buildPresence('online', 'playing', '', '')).toThrow('needs a text');
	});
});

describe('discord message powers', () => {
	test('editing is limited to this bot s own messages', async () => {
		const channel = mockChannel(CHANNEL_ID, { perms: ['SendMessages'] });
		const own = mockMessage(MSG_ID, { channel });
		const foreign = mockMessage('100000000000000007', { channel, authorId: USER_ID });
		(channel as any).messages.fetch = async (arg: unknown) => (typeof arg === 'object' ? new Map() : arg === MSG_ID ? own : foreign);
		const d = mod(mockClient({ channels: [channel] }));

		await throws(() => d.edit_message('100000000000000007', 'hacked'), 'only your own messages');
		const res = await d.edit_message(MSG_ID, 'fixed typo');
		expect(res.id).toBe(MSG_ID);
		expect(res.content).toBe('fixed typo');
		expect(res.allowedMentions).toEqual({ parse: [] });
		await throws(() => d.edit_message('garbage', 'x'), '17-20 digits');
	});

	test('edit_last_message finds this bot s newest message', async () => {
		const channel = mockChannel(CHANNEL_ID, { perms: ['SendMessages'] });
		const mine = mockMessage(MSG_ID, { channel });
		const theirs = mockMessage('100000000000000008', { channel, authorId: USER_ID });
		(channel as any).messages.fetch = async (arg: unknown) =>
			typeof arg === 'object'
				? new Map([
						[theirs.id, theirs],
						[mine.id, mine]
					])
				: theirs;
		const d = mod(mockClient({ channels: [channel] }));

		const res = await d.edit_last_message(CHANNEL_ID, 'updated');
		expect(res.id).toBe(MSG_ID);
		expect(res.content).toBe('updated');

		(channel as any).messages.fetch = async () => new Map([['100000000000000008', theirs]]);
		await throws(() => d.edit_last_message(CHANNEL_ID, 'updated'), 'no recent message from the bot');
	});

	test('deleting someone else s message needs ManageMessages, own does not', async () => {
		const guild = mockGuild({ mePerms: [] });
		const channel = mockChannel(CHANNEL_ID, { guild, perms: [] });
		const foreign = mockMessage('100000000000000007', { channel, authorId: USER_ID });
		const own = mockMessage(MSG_ID, { channel });
		(channel as any).messages.fetch = async (arg: unknown) => (typeof arg === 'object' ? new Map() : arg === MSG_ID ? own : foreign);
		const d = mod(mockClient({ guild, channels: [channel] }));

		await throws(() => d.delete_message('100000000000000007'), 'ManageMessages');
		expect(await d.delete_message(MSG_ID)).toBe('deleted'); // own message: no permission needed

		channel.grant('ManageMessages');
		expect(await d.delete_message('100000000000000007')).toBe('deleted');
	});

	test('sending checks SendMessages and never pings anyone', async () => {
		const guild = mockGuild({ mePerms: [] });
		const sendCalls: Record<string, unknown[]> = {};
		const channel = mockChannel(CHANNEL_ID, { guild, perms: [], send: sendCalls });
		const d = mod(mockClient({ guild, channels: [channel] }));

		await throws(() => d.send_message(CHANNEL_ID, '@everyone look'), 'SendMessages');
		channel.grant('SendMessages');
		await d.send_message(CHANNEL_ID, 'plain hello');
		const payload = (sendCalls.sent as [Record<string, unknown>][])[0][0];
		expect(payload.content).toBe('plain hello');
		expect((payload.allowedMentions as Record<string, unknown>).parse).toEqual([]);
		await throws(() => d.send_message(CHANNEL_ID, 'x'.repeat(2001)), '2000 chars');
		await throws(() => d.send_message(CHANNEL_ID, ''), 'needs content');
	});

	test('reactions: adding needs AddReactions, own removal is free, others need ManageMessages', async () => {
		const removed: string[] = [];
		const entry: ReactionEntry = {
			emoji: { name: '👍' },
			users: {
				remove: async (u: string) => {
					removed.push(u);
					return u;
				}
			},
			remove: async () => 'cleared'
		};
		const guild = mockGuild({ mePerms: [] });
		const channel = mockChannel(CHANNEL_ID, { guild, perms: [] });
		const msg = mockMessage(MSG_ID, { channel, reactions: reactions({ '👍': entry }) });
		(channel as any).messages.fetch = async (arg: unknown) => (typeof arg === 'object' ? new Map() : msg);
		const d = mod(mockClient({ guild, channels: [channel] }));

		await throws(() => d.react(MSG_ID, '👍'), 'AddReactions');
		channel.grant('AddReactions');
		expect((await d.react(MSG_ID, '👍')).emoji).toBe('👍');

		// our own reaction: no permission needed at all
		await d.remove_reaction(MSG_ID, '👍');
		expect(removed).toEqual([BOT_ID]);
		// someone else's: ManageMessages (the bot only holds AddReactions)
		await throws(() => d.remove_reaction(MSG_ID, '👍', USER_ID), 'ManageMessages');
		channel.grant('ManageMessages');
		await d.remove_reaction(MSG_ID, '👍', USER_ID);
		expect(removed).toEqual([BOT_ID, USER_ID]);
	});

	test('a missing reaction and a junk id both say so', async () => {
		const guild = mockGuild({ mePerms: [] });
		const channel = mockChannel(CHANNEL_ID, { guild, perms: [] });
		const msg = mockMessage(MSG_ID, { channel, reactions: reactions({}) });
		(channel as any).messages.fetch = async (arg: unknown) => (typeof arg === 'object' ? new Map() : msg);
		const d = mod(mockClient({ guild, channels: [channel] }));

		await throws(() => d.delete_reaction(MSG_ID, '👍'), "no '👍' reaction");
		await throws(() => d.remove_reaction(MSG_ID, '👍'), "no '👍' reaction");
		await throws(() => d.get_message('nope'), '17-20 digits');
	});

	test('clearing an emoji from everyone is moderation, and custom emoji ids resolve', async () => {
		const entry: ReactionEntry = { emoji: { name: 'party' }, remove: async () => 'cleared' };
		const guild = mockGuild({ mePerms: [] });
		const channel = mockChannel(CHANNEL_ID, { guild, perms: [] });
		// no resolve() on the manager: '<a:party:id>' must still find the reaction
		const msg = mockMessage(MSG_ID, { channel, reactions: reactions({ [ROLE_ID]: entry }, false) });
		(channel as any).messages.fetch = async (arg: unknown) => (typeof arg === 'object' ? new Map() : msg);
		const d = mod(mockClient({ guild, channels: [channel] }));

		await throws(() => d.delete_reaction(MSG_ID, '<a:party:100000000000000006>'), 'ManageMessages');
		channel.grant('ManageMessages');
		expect(await d.delete_reaction(MSG_ID, '<a:party:100000000000000006>')).toBe('cleared');
	});
});

describe('discord member and guild powers', () => {
	test('kick: permission first, then owner/self/hierarchy, then it runs', async () => {
		const calls: Record<string, unknown[]> = {};
		const guild = mockGuild({
			mePerms: [],
			meRolePos: 5,
			members: { [USER_ID]: member(USER_ID, 3, calls), [OWNER_ID]: member(OWNER_ID, 9, calls) },
			calls
		});
		const d = mod(mockClient({ guild }));

		await throws(() => d.kick_member(USER_ID, 'spam'), 'missing permission KickMembers');
		guild.grant('KickMembers');
		await throws(() => d.kick_member(OWNER_ID, 'try me'), 'server owner');
		await throws(() => d.kick_member(BOT_ID, 'oof'), 'yourself');
		expect(calls.kick).toBeUndefined(); // nothing happened yet

		await d.kick_member(USER_ID, 'spam');
		expect(calls.kick).toEqual([['spam']]);

		// a target whose top role sits above ours is off limits
		const high = mockGuild({
			mePerms: ['KickMembers'],
			meRolePos: 2,
			members: { [USER_ID]: member(USER_ID, 7, calls) },
			calls
		});
		await throws(() => mod(mockClient({ guild: high })).kick_member(USER_ID, 'nope'), 'not below yours');
	});

	test('timeout validates the duration, then the permission, then hierarchy', async () => {
		const calls: Record<string, unknown[]> = {};
		const guild = mockGuild({ mePerms: [], meRolePos: 5, members: { [USER_ID]: member(USER_ID, 3, calls) }, calls });
		const d = mod(mockClient({ guild }));

		await throws(() => d.timeout_member(USER_ID, 0, ''), 'between 1 and 2419200');
		await throws(() => d.timeout_member(USER_ID, 600, ''), 'missing permission ModerateMembers');
		guild.grant('ModerateMembers');
		await d.timeout_member(USER_ID, 600, 'chill');
		expect(calls.timeout).toEqual([[600_000, 'chill']]);

		await d.untimeout_member(USER_ID, 'done');
		expect(calls.timeout![1]).toEqual([null, 'done']);
		await throws(() => d.timeout_member('garbage', 600), '17-20 digits');
	});

	test('roles: ManageRoles, then reach, then the target hierarchy', async () => {
		const calls: Record<string, unknown[]> = {};
		const helpers = { id: ROLE_ID, position: 2, managed: false, name: 'helpers' };
		const above = { id: '100000000000000010', position: 9, managed: false, name: 'admin' };
		const guild = mockGuild({
			mePerms: [],
			meRolePos: 5,
			members: { [USER_ID]: member(USER_ID, 3, calls) },
			roles: { [ROLE_ID]: helpers, '100000000000000010': above },
			calls
		});
		const d = mod(mockClient({ guild }));

		await throws(() => d.grant_role(USER_ID, ROLE_ID, ''), 'missing permission ManageRoles');
		guild.grant('ManageRoles');
		await throws(() => d.grant_role(USER_ID, GUILD_ID, ''), '@everyone');
		await throws(() => d.grant_role(USER_ID, '100000000000000010', ''), 'your top role is at 5');
		expect(calls['roles.add']).toBeUndefined();

		await d.grant_role(USER_ID, ROLE_ID, 'helper');
		expect(calls['roles.add']).toEqual([[ROLE_ID, 'helper']]);
		await d.revoke_role(USER_ID, ROLE_ID, 'no more');
		expect(calls['roles.remove']).toEqual([[ROLE_ID, 'no more']]);
		expect(await d.has_role(USER_ID, ROLE_ID)).toBe(false);
	});

	test('a member can be read before it is acted on', async () => {
		const guild = mockGuild({ members: { [USER_ID]: member(USER_ID, 3) } });
		const d = mod(mockClient({ guild }));
		const info = await d.get_member(USER_ID);
		expect(info.id).toBe(USER_ID);
		expect(info.is_owner).toBe(false);
		expect(info.roles).toContain('Members');
		expect(info.top_role_position).toBe(3);
		await throws(() => d.get_member('nope'), '17-20 digits');
	});

	test('channel and expression creation is permission gated', async () => {
		const calls: Record<string, unknown[]> = {};
		const guild = mockGuild({ mePerms: [], calls });
		const d = mod(mockClient({ guild }));

		await throws(() => d.create_channel('general'), 'missing permission ManageChannels');
		guild.grant('ManageChannels');
		await d.create_channel('general');
		await throws(() => d.create_channel('   '), 'non-empty');
		await throws(() => d.create_channel('x'.repeat(101)), 'too long');
		expect((calls.channelCreate as [Record<string, unknown>][])[0][0].name).toBe('general');

		// uploads download the asset OURSELVES first (no local paths, no
		// private hosts, no discord.js-side fetch): stub fetch for this test
		const realFetch = globalThis.fetch;
		const fetched: string[] = [];
		globalThis.fetch = (async (url: unknown) => {
			fetched.push(String(url));
			return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-length': '3' } });
		}) as unknown as typeof fetch;
		try {
			await throws(() => d.create_emoji('party', 'https://cdn/x.png'), 'one of');
			guild.grant('CreateGuildExpressions');
			await d.create_emoji('party', 'https://cdn/x.png');
			expect((calls.emojiCreate as [Record<string, unknown>][])[0][0].name).toBe('party');
			expect(fetched).toEqual(['https://cdn/x.png']);
			// the URL guard: file paths and private hosts never leave the process
			await throws(() => d.create_emoji('evil', '/etc/passwd'), 'https URL');
			await throws(() => d.create_emoji('evil', 'http://169.254.169.254/x.png'), 'https URL');
			await throws(() => d.create_emoji('evil', 'https://127.0.0.1/x.png'), 'not allowed');
			expect(fetched.length).toBe(1); // refusals never fetched
			await throws(() => d.edit_emoji('nope', 'x'), '17-20 digits');
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe('discord lookup caching and poll validation', () => {
	test('message lookups remember their channel instead of re-probing everything', async () => {
		const msg = mockMessage(MSG_ID, {});
		let probesA = 0;
		const channelA = mockChannel('100000000000000020', { byId: {} });
		const fetchA = (channelA as { messages: { fetch: (arg: unknown) => Promise<unknown> } }).messages.fetch;
		(channelA as { messages: { fetch: (arg: unknown) => Promise<unknown> } }).messages.fetch = async (arg: unknown) => {
			probesA++;
			return await fetchA(arg);
		};
		const channelB = mockChannel('100000000000000021', { byId: { [MSG_ID]: msg } });
		const list = [channelA, channelB];
		const d = mod(mockClient({ channels: list }));

		expect((await d.get_message(MSG_ID)).id).toBe(MSG_ID);
		expect(probesA).toBe(1); // scanned A once, found it in B
		expect((await d.get_message(MSG_ID)).id).toBe(MSG_ID);
		expect(probesA).toBe(1); // memoized: A was not probed again

		// stale memo entry (channel gone) falls back to the scan, then errors clearly
		list.splice(1, 1);
		await throws(() => d.get_message(MSG_ID), 'not found');
		expect(probesA).toBe(2);
	});

	test('poll answers are validated before permissions are even looked at', async () => {
		const guild = mockGuild({ mePerms: [] });
		const sendCalls: Record<string, unknown[]> = {};
		const channel = mockChannel(CHANNEL_ID, { guild, perms: [], send: sendCalls });
		const d = mod(mockClient({ guild, channels: [channel] }));

		await throws(() => d.send_poll(CHANNEL_ID, '', [{ label: 'a' }, { label: 'b' }], 24), 'title');
		await throws(() => d.send_poll(CHANNEL_ID, 'Q?', [{ label: 'a' }], 24), '2..10');
		await throws(() => d.send_poll(CHANNEL_ID, 'Q?', [{ label: 'a' }, { label: '   ' }], 24), 'answer 2');
		await throws(() => d.send_poll(CHANNEL_ID, 'Q?', [{ label: 'a' }, { label: 'b' }], 0), '1..768');
		await throws(() => d.send_poll(CHANNEL_ID, 'Q?', [{ label: 'a' }, { label: 'b' }], 24), 'SendMessages');

		channel.grant('SendMessages');
		await d.send_poll(CHANNEL_ID, 'Q?', [{ label: 'a' }, { label: 'b' }], 24);
		const payload = (sendCalls.sent as [Record<string, unknown>][])[0][0] as { poll: { answers: unknown[] }; allowedMentions: unknown };
		expect(payload.poll.answers.length).toBe(2);
		expect(payload.allowedMentions).toEqual({ parse: [] });
	});
});

describe('discord through the TooLang interpreter', () => {
	test('set_presence works end to end and its errors reach the model', async () => {
		const client = mockClient();
		const ctx = { discord: client as unknown as DiscordClient };
		const ok = await runFromSource('return(discord.set_presence("dnd", "listening", "podcast").status)', {}, ctx);
		expect(ok).toBe('dnd');
		expect(client.state.payload).toEqual({ status: 'dnd', activities: [{ type: 2, name: 'podcast' }] });

		expect(await runFromSource('return(discord.get_presence().status)', {}, ctx)).toBe('online');
		await throws(() => runFromSource('return(discord.set_presence("meh"))', {}, ctx), 'status must be one of');
		await throws(() => runFromSource('return(discord.kick_member("100000000000000002"))', {}, ctx), 'no guild found');
	});
});
