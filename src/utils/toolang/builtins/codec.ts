/// Befaci @ Mozilla Public License V2.0
/// Please see the LICENSE file for more information.
// TooLang codec module: base64, hex, url, hash

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { RuntimeError } from "../evaluator.js";

export function codec(): Record<string, unknown> {
	return {
		base64Encode: (text: unknown) => Buffer.from(String(text), "utf-8").toString("base64"),
		base64Decode: (text: unknown) => Buffer.from(String(text), "base64").toString("utf-8"),
		hexEncode: (text: unknown) => Buffer.from(String(text), "utf-8").toString("hex"),
		hexDecode: (text: unknown) => {
			const hex = String(text).replace(/[^0-9a-fA-F]/g, "");
			if (hex.length % 2 !== 0) throw new RuntimeError("codec.hexDecode: invalid hex (odd length)");
			return Buffer.from(hex, "hex").toString("utf-8");
		},
		urlEncode: (text: unknown) => encodeURIComponent(String(text)),
		urlDecode: (text: unknown) => {
			try { return decodeURIComponent(String(text)) }
			catch { throw new RuntimeError("codec.urlDecode: malformed percent-encoding") }
		},
		hash: (algo: unknown, text: unknown) => {
			const a = String(algo).toLowerCase();
			const allowed = ["sha1", "sha256", "sha384", "sha512", "md5"];
			if (!allowed.includes(a)) throw new RuntimeError(`codec.hash: algorithm '${a}' not allowed (use sha1/sha256/sha384/sha512/md5)`);
			return createHash(a).update(String(text)).digest("hex");
		},
		randomToken: (bytes?: unknown) => randomBytes(Math.min(Math.max(Number(bytes ?? 32), 8), 128)).toString("base64url"),
		uuid: () => randomUUID(),
	};
}
