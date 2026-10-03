// Docker builtin: the enabled gate must hold for every op, paths must never
// reach a shell string unchecked, and image/port policy runs before any CLI.

import { describe, test, expect } from "bun:test";
import { Docker, DockerPolicy } from "./builtins/docker.js";

function policy(over: Partial<DockerPolicy> = {}): DockerPolicy {
	return {
		enabled: false,
		defaultImage: "debian:bookworm",
		allowedPorts: ["3456-35665"],
		disallowedImages: ["ftp", "ssh", "windows"],
		maxContainers: 100,
		...over,
	};
}

function errorOf(call: () => unknown): string {
	try {
		call();
	} catch (err) {
		return (err as Error).message;
	}
	return "";
}

describe("docker enabled gate", () => {
	test("every op refuses while [docker].enabled is false, naming the op", () => {
		const d = Docker(() => policy());
		const ops: [string, () => unknown][] = [
			["list", () => d.list()],
			["run", () => d.run("web", "ls -la")],
			["create", () => d.create("web", { image: "nginx:alpine" })],
			["remove", () => d.remove("web")],
			["start", () => d.start("web")],
			["stop", () => d.stop("web")],
			["restart", () => d.restart("web")],
			["get_info", () => d.get_info("web")],
			["get_state", () => d.get_state("web")],
			["get_console_logs", () => d.get_console_logs("web")],
			["get_file_content", () => d.get_file_content("web", "/etc/hosts")],
			["rmfile", () => d.rmfile("web", "/tmp/a")],
			["mvfile", () => d.mvfile("web", "/tmp/a", "/tmp/b")],
			["edit_file", () => d.edit_file("web", "/tmp/a", "hi")],
			["mkdir", () => d.mkdir("web", "/tmp/x")],
			["rmdir", () => d.rmdir("web", "/tmp/x")],
			["lsdir", () => d.lsdir("web", "/tmp")],
			["mvdir", () => d.mvdir("web", "/tmp/a", "/tmp/b")],
			["recreate", () => d.recreate("web")],
			["edit", () => d.edit("web", { image: "nginx:alpine" })],
		];
		for (const [op, call] of ops) {
			const err = errorOf(call);
			expect(err, `docker.${op} must be gated`).toContain("docker is disabled");
			expect(err, `docker.${op} must name itself in the error`).toContain(`docker.${op}:`);
		}
	});
});

describe("edit_file", () => {
	test("refuses paths that would reach the shell unchecked", () => {
		const d = Docker(() => policy({ enabled: true }));
		expect(errorOf(() => d.edit_file("web", "/app/a; rm -rf /", "x"))).toContain("invalid path");
		expect(errorOf(() => d.edit_file("web", "/app/$(whoami)", "x"))).toContain("invalid path");
		expect(errorOf(() => d.edit_file("web", "/app/`id`", "x"))).toContain("invalid path");
		expect(errorOf(() => d.edit_file("web", "/app/../../etc/passwd", "x"))).toContain("invalid path");
		expect(errorOf(() => d.edit_file("web", "/app/with space.txt", "x"))).toContain("invalid path");
		expect(errorOf(() => d.edit_file("web", "", "x"))).toContain("invalid path");
	});

	test("caps the content size", () => {
		const d = Docker(() => policy({ enabled: true }));
		expect(errorOf(() => d.edit_file("web", "/app/ok.txt", "x".repeat(1_000_001)))).toContain("exceeds");
	});

	test("still gates before touching the CLI", () => {
		const d = Docker(() => policy({ enabled: false }));
		expect(errorOf(() => d.edit_file("web", "/app/ok.txt", "content"))).toContain("docker is disabled");
	});
});

describe("image and name policy", () => {
	test("disallowed images are refused before any docker command runs", () => {
		const d = Docker(() => policy({ enabled: true }));
		expect(errorOf(() => d.create("web", { image: "ftp:latest" }))).toContain("disallowed");
		expect(errorOf(() => d.create("web", { image: "ssh" }))).toContain("disallowed");
		expect(errorOf(() => d.create("web", { image: "windows/servercore" }))).toContain("disallowed");
		// the documented (name, image, config) shorthand is validated the same way
		expect(errorOf(() => d.create("web", "ftp", { ports: [] }))).toContain("disallowed");
	});

	test("an allowlist, when set, beats everything else", () => {
		const d = Docker(() => policy({ enabled: true, allowedImages: ["nginx:alpine"] }));
		expect(errorOf(() => d.create("web", { image: "redis:7" }))).not.toBe("");
		expect(errorOf(() => d.create("web", { image: "nginx:alpine", ports: [99_999] }))).toContain("invalid port");
	});

	test("container names and ports are validated", () => {
		const d = Docker(() => policy({ enabled: true }));
		expect(errorOf(() => d.create("bad name!", { image: "nginx:alpine" }))).toContain("invalid container name");
		expect(errorOf(() => d.create("ok_name", { image: "nginx:alpine", ports: [80] }))).toContain("outside the allowed ranges");
		expect(errorOf(() => d.run("bad;name", "ls"))).toContain("invalid container name");
	});
});
