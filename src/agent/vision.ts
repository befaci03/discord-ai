// Image attachments for vision-capable chat models.
//
// Discord hands us attachment URLs; the PROVIDER fetches them (we never
// download images ourselves), so the only URLs that may leave this process
// are Discord CDN links, capped per message. Whether the chosen model can
// take images is decided here: an explicit config flag wins, otherwise a
// conservative name heuristic (a false positive makes the provider reject
// the WHOLE request, so unknown families do not match).

/** max image attachments forwarded with one message */
export const MAX_IMAGES = 4;

/** Discord hosts attachments are served from (the only URLs we forward) */
const DISCORD_CDN = ['cdn.discordapp.com', 'media.discordapp.net'];

/**
 * Does this model name look like it accepts image input? Override per model
 * with `vision = true/false` under [agent.models] when the heuristic is
 * wrong for your gateway's naming.
 */
export function supportsVision(modelName: string): boolean {
	const n = String(modelName ?? '')
		.trim()
		.toLowerCase();
	if (n.length === 0) return false;
	// openai: gpt-4o / 4.1 / 5 and the o-series; anthropic: claude 3+ (but
	// not claude-2/instant); google: gemini; common open vision families
	if (n.startsWith('claude')) return !n.startsWith('claude-2') && !n.startsWith('claude-instant');
	return /^(gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4|gemini|pixtral|llava|qwen[^ ]*-vl|glm-4v|internvl)/.test(n) || n.includes('vision');
}

/** Shape we accept from Discord's attachment objects. */
export interface AttachmentLike {
	contentType?: string | null;
	url?: string | null;
}

/**
 * Pick the attachment URLs worth forwarding: https, image/*, served from
 * Discord's own CDN, at most `cap` of them. Everything else (foreign hosts,
 * http, non-image types) is dropped before it can leave the process.
 */
export function pickImageUrls(attachments: AttachmentLike[], cap = MAX_IMAGES): string[] {
	const out: string[] = [];
	for (const a of attachments) {
		if (out.length >= cap) break;
		const url = typeof a.url === 'string' ? a.url : '';
		const type = typeof a.contentType === 'string' ? a.contentType : '';
		if (!url.startsWith('https://') || !type.startsWith('image/')) continue;
		let host = '';
		try {
			host = new URL(url).hostname;
		} catch {
			continue;
		}
		if (!DISCORD_CDN.includes(host)) continue;
		out.push(url);
	}
	return out;
}
