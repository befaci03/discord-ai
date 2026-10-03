// Row-length caps used by every database backend, so behavior stays identical
// (and tiny messages can't bloat the DB) regardless of the driver.
//
// They mirror src/db/sqlite.ts: every text/JSON field is truncated at insert.

/** user-visible columns */
export const MAX_ID = 1400; // rows identified by id (author id etc.)
export const MAX_USERNAME = 750;
export const MAX_GUILD_ID = 72;
export const MAX_TARGET = 700; // audit target
export const MAX_ACTION = 400; // audit action

/** content columns */
export const MAX_TOOL = 128; // tool name
export const MAX_CALLER = 128; // tool caller (e.g. "dashboard", "agent")
export const MAX_CONTENT = 7_000; // chat content / chat response
export const MAX_DETAILS = 24_000; // audit / tool run JSON details
export const MAX_ERROR = 512; // tool run error text
export const MAX_KV = 48_000; // kv value
export const MAX_KV_KEY = 256; // kv key
export const MAX_KV_NS = 96; // kv namespace
