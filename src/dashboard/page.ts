// Dashboard page: single minimalist HTML file, no external assets.
// Shows a login box until authed; then live-updating cards over WebSocket.

export function renderDashboard(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>discord-ai</title>
<style>
	:root { color-scheme: dark; --bg: #0f1115; --card: #171a21; --line: #242936; --fg: #d7dce4; --dim: #7c8595; --ok: #4cc38a; --warn: #f5a524; --bad: #e5484d; --accent: #6c8cff; }
	* { box-sizing: border-box; margin: 0; }
	body { background: var(--bg); color: var(--fg); font: 14px/1.5 ui-monospace, monospace; padding: 24px; max-width: 1080px; margin: 0 auto; }
	h1 { font-size: 18px; font-weight: 600; }
	.sub { color: var(--dim); font-size: 12px; margin-bottom: 20px; display: flex; gap: 14px; align-items: center; }
	.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bad); display: inline-block; margin-right: 6px; }
	.dot.live { background: var(--ok); }
	.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
	.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
	.card h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); margin-bottom: 10px; }
	.kv { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; }
	.kv span:first-child { color: var(--dim); }
	.ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--warn); } .dim { color: var(--dim); }
	table { width: 100%; border-collapse: collapse; font-size: 13px; }
	td, th { text-align: left; padding: 3px 6px 3px 0; white-space: nowrap; }
	td:last-child, th:last-child { white-space: normal; }
	th { color: var(--dim); font-weight: 500; }
	.run { display: flex; gap: 8px; margin-top: 10px; }
	select, input, button { background: var(--bg); border: 1px solid var(--line); color: var(--fg); border-radius: 6px; padding: 6px 8px; font: inherit; }
	input { flex: 1; }
	button { cursor: pointer; border-color: var(--accent); color: var(--accent); }
	button:hover { background: var(--accent); color: var(--bg); }
	pre { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 8px; margin-top: 10px; max-height: 240px; overflow: auto; font-size: 12px; }
	.err { color: var(--bad); }
	a { color: var(--accent); text-decoration: none; }
	#login { max-width: 360px; margin: 15vh auto 0; text-align: center; }
	#login input { width: 100%; margin: 12px 0; }
	#login button { width: 100%; }
	#app[hidden], #login[hidden] { display: none; }
	#feed { max-height: 200px; overflow: auto; font-size: 12px; }
	.feedline { padding: 2px 0; border-bottom: 1px solid var(--line); display: flex; gap: 10px; }
	.feedline .t { color: var(--dim); flex-shrink: 0; }
	.flash { animation: flash .6s; }
	@keyframes flash { 0% { background: var(--accent); } 100% { background: transparent; } }
	.tgl { border-color: var(--line); color: var(--dim); padding: 1px 8px; font-size: 11px; cursor: pointer; }
	.tgl.on { border-color: var(--ok); color: var(--ok); }
	.mrow { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 2px 0; }
	.mrow .name { flex: 1; }
	.off { color: var(--bad); text-decoration: line-through; }
</style>
</head>
<body>
	<div id="login">
		<div class="card">
			<h2>dashboard login</h2>
			<input id="pass" type="password" placeholder="passcode" autocomplete="current-password">
			<button onclick="login()">unlock</button>
			<pre id="loginMsg" class="dim" hidden></pre>
		</div>
	</div>

	<div id="app" hidden>
		<h1>discord-ai</h1>
		<div class="sub">
			<span><span class="dot" id="wsDot"></span><span id="wsState">connecting...</span></span>
			<span id="clock" class="dim"></span>
			<span style="flex:1"></span>
			<a href="#" onclick="logout(); return false;">logout</a>
		</div>

		<div class="grid">
			<div class="card"><h2>status</h2><div id="status">...</div></div>
			<div class="card"><h2>system</h2><div id="system">...</div></div>
			<div class="card"><h2>bot &amp; agent</h2><div id="bot">...</div></div>
			<div class="card"><h2>addons</h2><div id="addons">...</div></div>
			<div class="card"><h2>security</h2><div id="security">...</div></div>
			<div class="card"><h2>tool stats</h2><div id="stats">...</div></div>
			<div class="card"><h2>tools &amp; skills</h2><div id="manager">...</div></div>
			<div class="card" style="grid-column: 1 / -1;"><h2>run a tool</h2>
				<div class="run">
					<select id="toolSel"></select>
					<input id="toolArgs" placeholder='key=value key2="quoted"'>
					<button onclick="runTool()">run</button>
					<button onclick="logout()">logout</button>
				</div>
				<pre id="out" hidden></pre>
			</div>
			<div class="card" style="grid-column: 1 / -1;"><h2>live feed</h2><div id="feed"><span class="dim">waiting for events...</span></div></div>
			<div class="card" style="grid-column: 1 / -1;"><h2>recent audit</h2><div id="audit">...</div></div>
		</div>
	</div>

<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let ws = null, wsTimer = null, clockTimer = null;

async function j(url, opts) {
	const r = await fetch(url, opts);
	if (r.status === 401) { showLogin(); throw new Error("locked"); }
	const b = await r.json();
	if (!r.ok) throw new Error(b.error || r.status);
	return b;
}

function showLogin() { $("login").hidden = false; $("app").hidden = true; if (ws) { ws.close(); ws = null; } }
function showApp() {
	$("login").hidden = true; $("app").hidden = false;
	loadAll(); connectWs();
	if (!clockTimer) clockTimer = setInterval(() => $("clock").textContent = new Date().toLocaleTimeString(), 1000);
}

async function login() {
	const msg = $("loginMsg");
	msg.hidden = false; msg.className = "dim"; msg.textContent = "checking...";
	try {
		await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passcode: $("pass").value }) })
			.then(async (r) => { if (!r.ok) throw new Error((await r.json()).error || r.status); return r.json(); });
		msg.textContent = ""; $("pass").value = "";
		showApp();
	} catch (e) { msg.className = "err"; msg.textContent = e.message; }
}
$("pass").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });

async function logout() {
	try { await fetch("/api/logout", { method: "POST" }); } catch {}
	showLogin();
}

function setWs(ok, text) {
	$("wsDot").className = "dot" + (ok ? " live" : "");
	$("wsState").textContent = text;
}

function connectWs() {
	if (ws) { ws.close(); }
	setWs(false, "connecting...");
	ws = new WebSocket("ws://" + location.host + "/ws");
	ws.onopen = () => setWs(true, "live");
	ws.onmessage = (ev) => {
		try {
			const m = JSON.parse(ev.data);
			if (m.type === "snapshot") applySnapshot(m.data);
			else if (m.type === "event") pushEvent(m.data);
		} catch {}
	};
	ws.onclose = () => { setWs(false, "reconnecting..."); wsTimer = setTimeout(connectWs, 3000); };
	ws.onerror = () => ws.close();
}

function pushEvent(ev) {
	const feed = $("feed");
	if (feed.firstElementChild && feed.firstElementChild.className === "dim") feed.innerHTML = "";
	const line = document.createElement("div");
	line.className = "feedline flash";
	const time = new Date(ev.at).toLocaleTimeString();
	let text = "", cls = "";
	switch (ev.kind) {
		case "tool.run": text = "tool " + esc(ev.tool) + " by " + esc(ev.caller) + (ev.ok ? " ok in " + ev.ms + "ms" : ' FAILED: ' + esc(ev.error || '')); cls = ev.ok ? "ok" : "bad"; break;
		case "audit": text = "audit " + esc(ev.action) + " - " + esc(ev.target) + " by " + esc(ev.actor); break;
		case "bot.status": text = "bot " + (ev.online ? "online as " + esc(ev.user || '') : "offline"); cls = ev.online ? "ok" : "warn"; break;
		case "agent.status": text = "agent " + esc(ev.doing) + " (" + esc(ev.mode) + ")"; break;
		case "log": text = esc(ev.message); cls = ev.level === "error" ? "bad" : ev.level === "warn" ? "warn" : "dim"; break;
		default: text = esc(JSON.stringify(ev));
	}
	line.innerHTML = '<span class="t">' + time + '</span><span class="' + cls + '">' + text + '</span>';
	feed.prepend(line);
	while (feed.children.length > 60) feed.lastElementChild.remove();
		if (ev.kind === "tool.run") loadStats();
		if (ev.kind === "audit") {
			loadAudit();
			const action = String(ev.action);
			if (action.startsWith("tool ") || action.startsWith("skill ") || action.startsWith("addon ")) loadManager();
		}
}

function applySnapshot(s) {
	if (s.status) renderStatus(s.status);
	if (s.sessions || s.login) renderSecurity(s.sessions, s.login);
}

function parseArgs(raw) {
	const out = {};
	const rx = /(\\w+)=("([^"]*)"|\\S+)/g; let m;
	while ((m = rx.exec(raw)) !== null) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
	return out;
}

async function runTool() {
	const name = $("toolSel").value;
	const out = $("out");
	out.hidden = false;
	out.textContent = "running " + name + "...";
	try {
		const args = parseArgs($("toolArgs").value);
		const r = await j("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool: name, args }) });
		out.innerHTML = r.ok ? esc(JSON.stringify(r.data, null, 2)) : '<span class="err">' + esc(r.error) + '</span>';
	} catch (e) { if (e.message !== "locked") out.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }
}

function renderStatus(s) {
	const sys = s.health || {};
	const bot = s.bot || {};
	$("status").innerHTML =
		'<div class="kv"><span>tools</span><span>' + s.tools + '</span></div>' +
		'<div class="kv"><span>skills</span><span>' + s.skills + '</span></div>' +
		'<div class="kv"><span>addons</span><span>' + s.addons + '</span></div>' +
		'<div class="kv"><span>uptime</span><span class="ok">' + sys.uptimeSec + 's</span></div>';
	$("system").innerHTML =
		'<div class="kv"><span>platform</span><span>' + esc(sys.platform || '') + '</span></div>' +
		'<div class="kv"><span>node</span><span>' + esc(sys.node || '') + '</span></div>' +
		'<div class="kv"><span>memory</span><span>' + (sys.memUsedPct ?? '?') + '% of ' + (sys.memTotalMb ?? '?') + 'MB</span></div>' +
		'<div class="kv"><span>load (1m)</span><span>' + (sys.load1m ?? '?') + '</span></div>';
	$("bot").innerHTML =
		'<div class="kv"><span>discord</span><span class="' + (bot.online ? 'ok' : 'warn') + '">' + (bot.online ? esc(bot.user || 'online') : 'offline') + '</span></div>' +
		'<div class="kv"><span>guilds</span><span>' + (bot.guilds ?? 0) + '</span></div>' +
		'<div class="kv"><span>presence</span><span class="dim">' + esc(bot.status_text || '') + '</span></div>' +
		'<div class="kv"><span>agent</span><span>' + esc((s.agent || {}).name || '') + '</span></div>';
}

function renderSecurity(sessions, login) {
	$("security").innerHTML =
		'<div class="kv"><span>active sessions</span><span>' + ((sessions && sessions.sessions) || 0) + '</span></div>' +
		'<div class="kv"><span>oldest session</span><span>' + (sessions && sessions.oldestAgeSec != null ? sessions.oldestAgeSec + 's' : '-') + '</span></div>' +
		'<div class="kv"><span>login-guard IPs</span><span>' + ((login && login.trackedIps) || 0) + '</span></div>' +
		'<div class="kv"><span>locked IPs</span><span class="' + ((login && login.lockedIps) > 0 ? 'bad' : 'ok') + '">' + ((login && login.lockedIps) || 0) + '</span></div>';
}

let toolsCache = [], skillsCache = [], addonsCache = [];

async function toggle(kind, name, enabled) {
	try {
		await j("/api/" + kind + "s/toggle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, enabled }) });
		await loadManager();
	} catch (e) { if (e.message !== "locked") pushEvent({ kind: "log", level: "error", at: Date.now(), message: "toggle failed: " + e.message }); }
}

function renderManager() {
	const rows = [];
	for (const t of toolsCache) {
		rows.push('<div class="mrow"><span class="name' + (t.enabled ? '' : ' off') + '">' + esc(t.name) + '</span>' +
			'<button class="tgl' + (t.enabled ? ' on' : '') + '" onclick="toggle(\'tool\',\'' + esc(t.name) + '\',' + (!t.enabled) + ')">' + (t.enabled ? 'on' : 'off') + '</button></div>');
	}
	for (const s of skillsCache) {
		rows.push('<div class="mrow"><span class="name' + (s.enabled ? '' : ' off') + '">skill: ' + esc(s.name) + '</span>' +
			'<button class="tgl' + (s.enabled ? ' on' : '') + '" onclick="toggle(\'skill\',\'' + esc(s.name) + '\',' + (!s.enabled) + ')">' + (s.enabled ? 'on' : 'off') + '</button></div>');
	}
	for (const a of addonsCache) {
		const enabled = a.enabled !== false && a.configured;
		rows.push('<div class="mrow"><span class="name' + (enabled ? '' : ' off') + '">addon: ' + esc(a.name) + '</span>' +
			(a.configured
				? '<button class="tgl' + (enabled ? ' on' : '') + '" onclick="toggle(\'addon\',\'' + esc(a.name) + '\',' + (!enabled) + ')">' + (enabled ? 'on' : 'off') + '</button>'
				: '<span class="bad" title="' + esc(a.error || 'not configured') + '">off</span>'));
	}
	$("manager").innerHTML = rows.length === 0 ? '<span class="dim">nothing loaded</span>' : rows.join("");
	// refresh the runner dropdown to only show enabled tools
	const enabled = toolsCache.filter((t) => t.enabled);
	$("toolSel").innerHTML = enabled.map((t) => '<option value="' + esc(t.name) + '">' + esc(t.name) + '</option>').join("") || '<option value="">(all tools disabled)</option>';
}

async function loadManager() {
	try {
		toolsCache = await j("/api/tools");
		skillsCache = await j("/api/skills");
		addonsCache = await j("/api/addons");
		renderManager();
	} catch (e) { if (e.message !== "locked") $("manager").innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }
}

async function loadStats() {
	try {
		const st = await j("/api/stats");
		$("stats").innerHTML = st.length === 0 ? '<span class="dim">no tools</span>' : '<table><tr><th>tool</th><th>runs</th><th>fails</th><th>avg</th></tr>' +
			st.map((x) => '<tr><td>' + esc(x.tool) + '</td><td>' + x.runs + '</td><td class="' + (x.failures > 0 ? 'bad' : 'ok') + '">' + x.failures + '</td><td>' + Math.round(x.avgMs) + 'ms</td></tr>').join("") + '</table>';
	} catch (e) { if (e.message !== "locked") $("stats").innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }
}

async function loadAudit() {
	try {
		const au = await j("/api/audit");
		$("audit").innerHTML = au.length === 0 ? '<span class="dim">empty</span>' : au.slice(0, 12).map((x) =>
			'<div class="kv"><span>' + esc(x.action) + ' - ' + esc(x.target) + '</span><span class="dim">' + new Date(x.created_at).toLocaleTimeString() + '</span></div>'
		).join("");
	} catch (e) { if (e.message !== "locked") $("audit").innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }
}

async function loadAll() {
	try {
		const s = await j("/api/status");
		renderStatus(s);
		const tools = await j("/api/tools");
		toolsCache = tools;
		const addons = await j("/api/addons");
		$("addons").innerHTML = addons.length === 0 ? '<span class="dim">none enabled</span>' : addons.map((x) =>
			'<div class="kv"><span>' + esc(x.name) + '</span><span class="' + (x.configured ? 'ok' : 'bad') + '">' + (x.configured ? x.functions.length + ' fns' : esc(x.error || 'off')) + '</span></div>'
		).join("");
		await loadStats(); await loadAudit(); await loadManager();
		const sec = await fetch("/api/health").then((r) => r.json()).catch(() => null);
		void sec;
	} catch (e) { if (e.message === "locked") return; $("status").innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }
}

// boot: try authed; if 401 show login
(async () => {
	try { await j("/api/status"); showApp(); } catch { showLogin(); }
})();
</script>
</body>
</html>`;
}
