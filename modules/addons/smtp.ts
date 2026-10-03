/// Addon: smtp
/// Lets the agent send email through the operator's SMTP relay, using
/// nodemailer (pure JS: no shell, no install scripts). Security model:
/// - the LLM only ever sees to/subject/body/attachments: the sender identity,
///   relay and every other header are operator config, never model input
/// - to/subject are validated before anything touches the network; CRLF and
///   other control characters are rejected outright (no header injection)
/// - recipients are checked against addons.smtp.allowed_recipients (empty =
///   any recipient, operator's choice, called out in the startup note)
/// - attachments are realpath-jailed to attachment_dir (default: the toolang
///   fs root), size-capped, and read into Buffers ourselves so nodemailer
///   never touches the filesystem on its own
/// - TLS on by default (STARTTLS required, TLSv1.2+); the password comes
///   from env/config and never appears in logs, responses or errors
/// - sends are flagged dangerous, so the factory audit-logs the recipient
///   (never the body or attachments)

import { readFileSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { createTransport } from "nodemailer";
import type { Transporter } from "nodemailer";
import { AppConfig } from "../../src/utils/config.js";
import { Addon, AgentFunction } from "../../src/modules/types.js";

const MAX_ADDRESS = 320;
const MAX_SUBJECT = 200;
const MAX_BODY = 50_000;
const MAX_ATTACHMENTS = 10;
const MAX_ATTACH_TOTAL = 10_000_000; // bytes, all attachments combined
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const DOMAIN_RE = /^@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
// \x0a/\x0d are in here too: no newlines ever reach a header field
const CONTROL_RE = /[\x00-\x1f\x7f]/;

export interface SmtpConfig {
	host: string;
	port: number;
	secure: boolean;
	user?: string;
	pass?: string;
	from: string;
	/** exact addresses (case-insensitive) or "@domain" entries; empty = any */
	allowed_recipients: string[];
	/** refuse sessions that cannot upgrade to TLS (no-op for implicit TLS) */
	require_tls: boolean;
	timeout_ms: number;
	/** attachments must live inside this directory (absolute by init time) */
	attachment_dir: string;
}

/** Strict on purpose: a wrong TOML type must throw at init (the message ends
 * up in the dashboard status), never silently fall back to a looser default. */
function getConfig(config: AppConfig): SmtpConfig {
	const raw = (config.addons as unknown as Record<string, Record<string, unknown>>).smtp ?? {};
	const str = (k: string): string => {
		const v = raw[k];
		if (v === undefined) return "";
		if (typeof v !== "string") throw new Error(`smtp: ${k} must be a string`);
		return v.trim();
	};
	const bool = (k: string, dflt: boolean): boolean => {
		const v = raw[k];
		if (v === undefined) return dflt;
		if (typeof v !== "boolean") throw new Error(`smtp: ${k} must be true or false`);
		return v;
	};

	const secure = bool("secure", false);
	let port: number;
	if (raw.port === undefined) port = secure ? 465 : 587;
	else if (!Number.isInteger(raw.port)) throw new Error("smtp: port must be an integer");
	else port = raw.port as number;
	if (port < 1 || port > 65535) throw new Error(`smtp: port ${port} is out of range (1-65535)`);

	// a string here used to silently mean "allow every recipient": now it throws
	let allowed: string[] = [];
	if (raw.allowed_recipients !== undefined) {
		if (!Array.isArray(raw.allowed_recipients)) throw new Error('smtp: allowed_recipients must be an array of addresses or "@domain" entries');
		allowed = raw.allowed_recipients.map((entry) => {
			const e = String(entry).trim();
			if (EMAIL_RE.test(e) || DOMAIN_RE.test(e)) return e;
			throw new Error(`smtp: allowed_recipients entry '${e}' must be an email address or "@domain"`);
		});
	}

	let timeout = 15_000;
	if (raw.timeout_ms !== undefined) {
		const n = Number(raw.timeout_ms);
		if (!Number.isFinite(n)) throw new Error("smtp: timeout_ms must be a number");
		timeout = Math.min(Math.max(Math.floor(n), 1_000), 120_000);
	}

	return {
		host: str("host"),
		port,
		secure,
		user: str("user") || undefined,
		pass: str("pass") || undefined,
		from: str("from"),
		allowed_recipients: allowed,
		require_tls: bool("require_tls", true),
		timeout_ms: timeout,
		attachment_dir: path.resolve(str("attachment_dir") || config.agent.toolang.fs.root),
	};
}

class SmtpClient {
	private t: Transporter;

	constructor(private cfg: SmtpConfig) {
		this.t = createTransport({
			host: cfg.host,
			port: cfg.port,
			secure: cfg.secure,
			...(cfg.user ? { auth: { user: cfg.user, pass: cfg.pass } } : {}),
			// opportunistic is not enough: require_tls forces the STARTTLS upgrade
			...(cfg.secure ? {} : { requireTLS: cfg.require_tls }),
			connectionTimeout: cfg.timeout_ms,
			greetingTimeout: cfg.timeout_ms,
			socketTimeout: cfg.timeout_ms,
			tls: { minVersion: "TLSv1.2" },
		});
	}

	/** empty list = allow any (documented fail-open, same posture as github) */
	private recipientAllowed(to: string): boolean {
		const list = this.cfg.allowed_recipients;
		if (list.length === 0) return true;
		const lower = to.toLowerCase();
		return list.some((entry) => {
			const e = entry.toLowerCase();
			return e.startsWith("@") ? lower.endsWith(e) : e === lower;
		});
	}

	/**
	 * Validate + load attachments into memory. The path is canonicalized with
	 * realpath first (symlinks pointing out of the jail are refused), sizes
	 * are checked, and the Buffer is what nodemailer gets: no second file
	 * access from the transport, so no TOCTOU between check and read.
	 */
	private loadAttachments(raw: unknown): { filename: string; content: Buffer }[] {
		if (raw === undefined || raw === null) return [];
		if (!Array.isArray(raw)) throw new Error("smtp: attachments must be an array of file paths");
		if (raw.length > MAX_ATTACHMENTS) throw new Error(`smtp: at most ${MAX_ATTACHMENTS} attachments`);
		const root = this.cfg.attachment_dir;
		const prefix = root.endsWith(path.sep) ? root : root + path.sep;
		const out: { filename: string; content: Buffer }[] = [];
		let total = 0;
		for (const item of raw) {
			if (typeof item !== "string" || item.length === 0 || item.length > 1024) {
				throw new Error("smtp: attachment paths must be non-empty strings (max 1024 chars)");
			}
			if (item.includes("\0")) throw new Error("smtp: null bytes are not allowed in attachment paths");
			// absolute paths resolve as themselves, so they must also land in the jail
			const resolved = path.resolve(root, item);
			if (!resolved.startsWith(prefix)) throw new Error(`smtp: attachment '${item}' escapes the attachment directory`);
			let real: string;
			try {
				real = realpathSync(resolved);
			} catch {
				throw new Error(`smtp: attachment '${item}' does not exist`);
			}
			if (!real.startsWith(prefix)) throw new Error(`smtp: attachment '${item}' is a symlink pointing outside the attachment directory`);
			const st = statSync(real);
			if (!st.isFile()) throw new Error(`smtp: attachment '${item}' is not a regular file`);
			// read first, then count exact bytes: no stat-vs-read size drift
			const content = readFileSync(real);
			total += content.length;
			if (total > MAX_ATTACH_TOTAL) throw new Error(`smtp: attachments exceed ${MAX_ATTACH_TOTAL} bytes in total`);
			// basename only, control chars/quotes stripped: no filename injection
			const filename = path.basename(real).replace(/[\x00-\x1f\x7f"\\/]/g, "_").slice(0, 100) || "file";
			out.push({ filename, content });
		}
		return out;
	}

	async send(to: unknown, subject: unknown, body: unknown, attachments: unknown): Promise<unknown> {
		// recipient: single, plain address. The anchored regex admits no
		// whitespace, commas, angle brackets or CR/LF: one address, no headers.
		const addr = String(to ?? "").trim();
		if (addr.length === 0 || addr.length > MAX_ADDRESS) throw new Error(`smtp: 'to' must be 1-${MAX_ADDRESS} chars`);
		if (!EMAIL_RE.test(addr)) throw new Error("smtp: 'to' must be a single plain email address like name@example.com");
		if (!this.recipientAllowed(addr)) throw new Error(`smtp: recipient '${addr}' is not in addons.smtp.allowed_recipients`);

		const subj = String(subject ?? "").trim();
		if (subj.length === 0 || subj.length > MAX_SUBJECT) throw new Error(`smtp: subject must be 1-${MAX_SUBJECT} chars`);
		if (CONTROL_RE.test(subj)) throw new Error("smtp: subject must not contain control characters");

		const text = String(body ?? "");
		if (text.trim().length === 0) throw new Error("smtp: body must not be empty");
		if (text.length > MAX_BODY) throw new Error(`smtp: body too large (${text.length} > ${MAX_BODY} chars)`);

		const files = this.loadAttachments(attachments);
		try {
			const info = await this.t.sendMail({
				from: this.cfg.from, // operator config, never model input
				to: addr,
				subject: subj,
				text,
				attachments: files,
			});
			// messageId is the relay's queue id; the body/attachments are never echoed back
			return { ok: true, to: addr, messageId: String(info.messageId ?? "") };
		} catch (err) {
			// nodemailer surfaces the server response text, never the password
			throw new Error(`smtp: ${(err as Error).message}`);
		}
	}

	/** connect + EHLO + AUTH + QUIT without sending mail (setup/debug) */
	async verify(): Promise<unknown> {
		try {
			await this.t.verify();
			return { ok: true, relay: `${this.cfg.host}:${this.cfg.port}` };
		} catch (err) {
			throw new Error(`smtp: ${(err as Error).message}`);
		}
	}
}

function fn(
	name: string,
	description: string,
	parameters: Record<string, unknown>,
	execute: (args: Record<string, unknown>) => Promise<unknown>,
	dangerous = false,
): AgentFunction {
	return { name, description, parameters, execute, dangerous };
}

let client: SmtpClient | null = null;
let startupMsg: string | undefined;

export const SMTP: Addon = {
	name: "smtp",
	description: "Email sending for the agent through the configured SMTP relay (with recipient allowlist and attachment jail)",
	functions: [], // built in init() (needs config)
	init: (config: AppConfig) => {
		const cfg = getConfig(config);
		if (!cfg.host || !cfg.from) return false; // not configured yet
		if (cfg.user && !cfg.pass) throw new Error("smtp: addons.smtp.user is set but pass is empty");
		if (cfg.from.length > MAX_ADDRESS || CONTROL_RE.test(cfg.from)) throw new Error("smtp: addons.smtp.from must be a plain address (no control characters)");
		let dirOk = false;
		try {
			dirOk = statSync(cfg.attachment_dir).isDirectory();
		} catch {
			dirOk = false;
		}
		if (!dirOk) throw new Error(`smtp: attachment_dir '${cfg.attachment_dir}' is not a directory`);

		client = new SmtpClient(cfg);
		const list = cfg.allowed_recipients;
		startupMsg =
			`smtp: relay ${cfg.host}:${cfg.port} (${cfg.secure ? "implicit TLS" : cfg.require_tls ? "TLS required" : "TLS optional"}) as ${cfg.from} | ` +
			(list.length === 0 ? "recipient allowlist EMPTY: the agent may email anyone" : `recipient allowlist: ${list.length} entr${list.length === 1 ? "y" : "ies"}`);

		SMTP.functions = [
			fn(
				"smtp_send_email",
				"Send a plain-text email through the configured SMTP relay. Only send mail the user explicitly asked for, " +
					"to the exact recipient they gave you: never send unsolicited, bulk or promotional mail, never change the sender, " +
					"and only attach files the user asked for. Every send is audit-logged with the recipient.",
				{
					type: "object",
					properties: {
						to: { type: "string", description: "single recipient email address" },
						subject: { type: "string", description: `subject line, 1-${MAX_SUBJECT} chars, no line breaks` },
						body: { type: "string", description: `plain-text message, max ${MAX_BODY} chars` },
						attachments: {
							type: "array",
							maxItems: MAX_ATTACHMENTS,
							items: { type: "string" },
							description: "optional file paths inside the configured attachment directory",
						},
					},
					required: ["to", "subject", "body"],
				},
				(a) => client!.send(a.to, a.subject, a.body, a.attachments),
				true,
			),
			fn(
				"smtp_verify",
				"Test the SMTP relay connection and authentication without sending any mail (setup/debugging).",
				{ type: "object", properties: {} },
				() => client!.verify(),
			),
		];
		return true;
	},
	startupNote: () => startupMsg,
};
