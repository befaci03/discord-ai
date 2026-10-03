// Minimal WebSocket implementation (RFC 6455 subset), no dependencies.
// Only what the dashboard needs: text frames, ping/pong, close, masking,
// payloads up to 64KB. Protocol on top: JSON messages { type, data }.
//
// Why hand-rolled: the project wants a light custom WS protocol over JSON and
// zero extra dependencies (attack surface stays tiny).

import { createHash, randomBytes } from "node:crypto";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 96 * 1024;
const HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_CONNECTIONS = 6;

export class WsConnection {
	private buf = Buffer.alloc(0);
	private closed = false;
	private awaitingPong = true;
	lastSeen = Date.now();

	constructor(private socket: Socket, public readonly id: string, private onMessage: (data: string, ws: WsConnection) => void, private onClose: (ws: WsConnection) => void) {
		socket.on("data", (chunk: Buffer) => this.feed(chunk));
		socket.on("close", () => this.handleClose());
		socket.on("error", () => this.handleClose());
		socket.setNoDelay(true);
	}

	private handleClose(): void {
		if (this.closed) return;
		this.closed = true;
		this.onClose(this);
	}

	accept(): void {
		// handshake must have already been validated by the server; send 101
		this.closed = false;
	}

	send(type: string, data?: unknown): void {
		if (this.closed) return;
		try {
			const payload = Buffer.from(JSON.stringify({ type, data }), "utf-8");
			if (payload.length > MAX_MESSAGE_BYTES) return;
			this.writeFrame(0x1, payload);
		} catch {
			// serialization error: drop the message, keep the connection
		}
	}

	ping(): void {
		if (this.closed) return;
		this.awaitingPong = true;
		this.writeFrame(0x9, Buffer.alloc(0));
	}

	close(code = 1000): void {
		if (this.closed) return;
		const body = Buffer.alloc(2);
		body.writeUInt16BE(code);
		this.writeFrame(0x8, body);
		this.handleClose();
		this.socket.end();
	}

	private writeFrame(opcode: number, payload: Buffer): void {
		const len = payload.length;
		let header: Buffer;
		if (len < 126) {
			header = Buffer.from([0x80 | opcode, len]);
		} else if (len < 65_536) {
			header = Buffer.alloc(4);
			header[0] = 0x80 | opcode;
			header[1] = 126;
			header.writeUInt16BE(len, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 0x80 | opcode;
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(len), 2);
		}
		this.socket.write(Buffer.concat([header, payload]));
	}

	private feed(chunk: Buffer): void {
		this.buf = this.buf.length + chunk.length > MAX_MESSAGE_BYTES * 2 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
		while (true) {
			const frame = this.parseFrame();
			if (!frame) break;
			this.handleFrame(frame);
			if (this.closed) break;
		}
	}

	private parseFrame(): { opcode: number; payload: Buffer } | null {
		if (this.buf.length < 2) return null;
		const first = this.buf[0];
		const second = this.buf[1];
		const opcode = first & 0x0f;
		const masked = (second & 0x80) !== 0;
		let len = second & 0x7f;
		let offset = 2;
		if (len === 126) {
			if (this.buf.length < offset + 2) return null;
			len = this.buf.readUInt16BE(offset);
			offset += 2;
		} else if (len === 127) {
			if (this.buf.length < offset + 8) return null;
			const big = this.buf.readBigUInt64BE(offset);
			if (big > BigInt(MAX_MESSAGE_BYTES)) {
				this.close(1009);
				return null;
			}
			len = Number(big);
			offset += 8;
		}
		if (len > MAX_MESSAGE_BYTES) {
			this.close(1009);
			return null;
		}
		let mask: Buffer | null = null;
		if (masked) {
			if (this.buf.length < offset + 4) return null;
			mask = this.buf.subarray(offset, offset + 4);
			offset += 4;
		}
		if (this.buf.length < offset + len) return null;
		let payload = this.buf.subarray(offset, offset + len);
		if (mask) {
			payload = Buffer.from(payload); // copy before unmasking
			for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
		}
		this.buf = this.buf.subarray(offset + len);
		return { opcode, payload };
	}

	private handleFrame(frame: { opcode: number; payload: Buffer }): void {
		this.lastSeen = Date.now();
		switch (frame.opcode) {
			case 0x1: { // text
				if (this.closed) return;
				const text = frame.payload.toString("utf-8");
				if (text.length > 0) this.onMessage(text, this);
				return;
			}
			case 0x8: // close: echo it back
				this.writeFrame(0x8, Buffer.alloc(0));
				this.handleClose();
				this.socket.end();
				return;
			case 0x9: // ping -> pong
				this.writeFrame(0xA, frame.payload);
				return;
			case 0xA: // pong
				this.awaitingPong = false;
				return;
			default:
				return; // binary/continuation: ignore (JSON-only protocol)
		}
	}
}

export interface WsHubEvents {
	onClient: (ws: WsConnection) => void;
}

export class WsHub {
	private connections = new Set<WsConnection>();
	private heartbeat: ReturnType<typeof setInterval>;

	constructor(private onClient: (ws: WsConnection) => void) {
		this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_INTERVAL_MS);
		this.heartbeat.unref();
	}

	/** Validate an upgrade request's headers. Returns the accept key or null. */
	static acceptKey(headers: IncomingMessage["headers"]): string | null {
		const key = headers["sec-websocket-key"];
		const version = headers["sec-websocket-version"];
		if (typeof key !== "string" || key.length < 16) return null;
		if (version !== "13") return null;
		return createHash("sha1").update(key + GUID).digest("base64");
	}

	/** Complete an upgrade that already passed auth + accept-key checks. */
	upgrade(req: IncomingMessage, socket: Socket, onMessage?: (data: string, ws: WsConnection) => void): WsConnection | null {
		const accept = WsHub.acceptKey(req.headers);
		if (!accept) {
			socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
			socket.destroy();
			return null;
		}
		if (this.connections.size >= MAX_CONNECTIONS) {
			socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
			socket.destroy();
			return null;
		}
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			`Sec-WebSocket-Accept: ${accept}\r\n` +
			"\r\n",
		);
		const id = randomBytes(8).toString("hex");
		const ws = new WsConnection(socket, id, (data, conn) => {
			// cap inbound: parse and drop (protocol is server-push only for now,
			// but ping-style keepalives arrive as messages in some clients)
			try {
				const parsed = JSON.parse(data) as { type?: string };
				if (parsed.type === "ping") conn.send("pong");
				if (onMessage) onMessage(data, conn);
			} catch { /* ignore malformed */ }
		}, (conn) => this.connections.delete(conn));
		this.connections.add(ws);
		this.onClient(ws);
		return ws;
	}

	broadcast(type: string, data?: unknown): void {
		for (const ws of this.connections) ws.send(type, data);
	}

	clientCount(): number {
		return this.connections.size;
	}

	private sweep(): void {
		const now = Date.now();
		for (const ws of this.connections) {
			if (now - ws.lastSeen > HEARTBEAT_INTERVAL_MS * 2) {
				ws.close(1001);
				continue;
			}
			ws.ping();
		}
	}

	closeAll(): void {
		for (const ws of this.connections) ws.close();
		clearInterval(this.heartbeat);
	}
}
