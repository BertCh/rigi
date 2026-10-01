#!/usr/bin/env node
// Rigi regression gate (roadmap N1). One runner, two tiers:
//   fast  no browser, no dev server: tsc, biome (per-file ratchet), every node/tsx unit check.
//   full  fast + the browser checks (style-baseline = classic / concord-off pixel parity, deck smoke,
//         eval-app), each under scripts/gpu/with-render-lock.mjs, one at a time, against a dev server
//         this script starts on its own port (default 3130) unless --url is given.
//
//   node scripts/ci/run.mjs [fast|full] [options]
//     --only a,b          run only these check ids          --skip a,b     drop these ids
//     --list              print the checks and exit         --jobs N       parallel fast checks (default 4)
//     --biome changed|all biome scope (default: all under CI=1, else changed vs upstream + worktree)
//     --url URL           use this dev server instead of starting one
//     --port N            port for the dev server we start (default 3130)
//     --update-baseline   rewrite known-failures.json's biome counts and eval-app minima (observed − 1, other fields kept)
//     --strict            known failures count as failures too
//
// Statuses: PASS, FAIL, KNOWN (fails, but listed in known-failures.json → does not fail the gate),
// FIXED (listed as known but passed → remove it from the list), SKIP (untracked inputs missing).
// Exit 0 iff no FAIL. Logs: out/ci/logs/<id>.log; summary: out/ci/last-run.json. See README.md.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { CHECKS } from "./checks.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT = join(ROOT, "out/ci");
const LOGS = join(OUT, "logs");
const BASELINE_FILE = join(import.meta.dirname, "known-failures.json");

// ---- args ---------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(`--${k}`);
const opt = (k, d) => {
	const i = argv.indexOf(`--${k}`);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")
		? argv[i + 1]
		: d;
};
const list = (s) =>
	s
		? s
				.split(",")
				.map((x) => x.trim())
				.filter(Boolean)
		: null;
const tier = argv.find((a) => a === "fast" || a === "full") ?? "fast";
const only = list(opt("only"));
const skip = list(opt("skip")) ?? [];
const jobs = Math.max(1, Number(opt("jobs", 4)));
const isCI = !!process.env.CI;
const biomeScope = opt("biome", isCI ? "all" : "changed");
const strict = flag("strict");
const updateBaseline = flag("update-baseline");

for (const id of [...(only ?? []), ...skip])
	if (!CHECKS.some((c) => c.id === id)) {
		console.error(`unknown check id: ${id} (see --list)`);
		process.exit(2);
	}

if (flag("list")) {
	for (const c of CHECKS)
		console.log(
			`${c.id.padEnd(20)} ${c.tier.padEnd(5)} ${c.group.padEnd(10)} ${c.builtin ? `(builtin ${c.builtin})` : c.cmd.join(" ")}${c.needs ? `  needs ${c.needs.join(", ")}` : ""}${c.optIn ? "  (opt-in: --only)" : ""}`,
		);
	process.exit(0);
}

const baseline = existsSync(BASELINE_FILE)
	? JSON.parse(readFileSync(BASELINE_FILE, "utf8"))
	: { checks: {}, biome: { errors: {} }, evalApp: {} };
// A known failure is a string (always expected) or { reason, when: "ci" } (expected only under CI=1,
// e.g. a check that needs gitignored data a fresh clone lacks).
const isKnown = (id) => {
	const k = baseline.checks?.[id];
	return typeof k === "string" || (!!k && (k.when !== "ci" || isCI));
};

const selected = CHECKS.filter(
	(c) =>
		(tier === "full" || c.tier === "fast") &&
		(!only || only.includes(c.id)) &&
		(!c.optIn || only?.includes(c.id)) &&
		!skip.includes(c.id),
);

mkdirSync(LOGS, { recursive: true });

// ---- process helpers ----------------------------------------------------------------------
/** Process groups of live detached children, so Ctrl-C / SIGTERM can reach grandchildren (chromium, vite). */
const groups = new Set();
function killGroups(sig = "SIGTERM") {
	for (const pid of groups) {
		try {
			process.kill(-pid, sig);
		} catch {}
	}
}

/** Run argv in ROOT, capture stdout+stderr to a log; kill the whole group on timeout. */
function run(cmd, { env = {}, timeoutS = 600, log }) {
	return new Promise((done) => {
		const t0 = Date.now();
		const child = spawn(cmd[0], cmd.slice(1), {
			cwd: ROOT,
			env: { ...process.env, FORCE_COLOR: "0", ...env },
			detached: true, // own process group → the timeout kill reaches grandchildren (chromium)
			stdio: ["ignore", "pipe", "pipe"],
		});
		groups.add(child.pid);
		let out = "";
		const onData = (b) => {
			out += b.toString();
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {}
			setTimeout(() => {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {}
			}, 5000).unref();
		}, timeoutS * 1000);
		const finish = (code, err) => {
			clearTimeout(timer);
			groups.delete(child.pid);
			if (err) out += `\n[ci] spawn error: ${err.message}\n`;
			if (log) writeFileSync(log, `$ ${cmd.join(" ")}\n\n${out}`);
			done({
				code: err ? 127 : code,
				out,
				timedOut,
				secs: (Date.now() - t0) / 1000,
			});
		};
		child.on("error", (e) => finish(127, e));
		child.on("close", (code) => finish(code ?? 1));
	});
}

/** The first line that looks like an error (thrown TypeError, "FAIL …"), else the last line. */
const firstError = (s) =>
	(
		s
			.split("\n")
			.map((l) => l.trim())
			.find((l) => /^(\w*Error\b|FAIL\b|✗|×)/.test(l)) ?? lastLine(s)
	).slice(0, 110);
const lastLine = (s) =>
	s
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(-1)[0]
		?.slice(0, 110) ?? "";

// ---- biome: per-file ratchet --------------------------------------------------------------
const BIOME_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|json|jsonc)$/;
function git(args) {
	try {
		return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}
function biomeFiles() {
	// untracked-but-not-ignored files count as "in the repo": they are what the next commit adds
	const all = git(["ls-files", "-co", "--exclude-standard"]).split("\n");
	if (biomeScope === "all") return all.filter((f) => BIOME_EXT.test(f));
	const base =
		git(["merge-base", "HEAD", "@{upstream}"]) ||
		git(["merge-base", "HEAD", "origin/master"]) ||
		"HEAD";
	const changed = new Set([
		...git(["diff", "--name-only", base]).split("\n"),
		...git(["ls-files", "-o", "--exclude-standard"]).split("\n"),
	]);
	return all.filter((f) => changed.has(f) && BIOME_EXT.test(f));
}

async function runBiome(check) {
	const log = join(LOGS, "biome.log");
	const files = biomeFiles().filter((f) => existsSync(join(ROOT, f)));
	if (!files.length)
		return { status: "PASS", secs: 0, note: `no ${biomeScope} files to check` };
	const r = await run(
		[
			"npx",
			"biome",
			"check",
			"--reporter=json",
			"--max-diagnostics=none",
			"--files-ignore-unknown=true",
			"--no-errors-on-unmatched",
			...files,
		],
		{ timeoutS: check.timeoutS, log },
	);
	const j0 = r.out.indexOf('{"summary"');
	let rep;
	try {
		rep = JSON.parse(r.out.slice(j0, r.out.lastIndexOf("}") + 1));
	} catch {
		return {
			status: "FAIL",
			secs: r.secs,
			note: `biome output unparsable: ${lastLine(r.out)}`,
		};
	}
	const errs = {};
	for (const d of rep.diagnostics ?? [])
		if (d.severity === "error") {
			const p = d.location?.path ?? "?";
			errs[p] = (errs[p] ?? 0) + 1;
		}
	const known = baseline.biome?.errors ?? {};
	const worse = Object.entries(errs).filter(([f, n]) => n > (known[f] ?? 0));
	const better = Object.entries(known).filter(
		([f, n]) => files.includes(f) && (errs[f] ?? 0) < n,
	);
	const total = Object.values(errs).reduce((a, b) => a + b, 0);
	check.biomeErrors = errs;
	let log2 = `\n[ci] ${files.length} files (${biomeScope}), ${total} errors\n`;
	for (const [f, n] of worse)
		log2 += `[ci] NEW  ${f}: ${n} errors (baseline ${known[f] ?? 0}) → npx biome check ${f}\n`;
	for (const [f, n] of better)
		log2 += `[ci] BETTER ${f}: ${errs[f] ?? 0} errors (baseline ${n}) → --update-baseline to ratchet\n`;
	writeFileSync(log, readFileSync(log, "utf8") + log2);
	const scope = `${files.length} ${biomeScope} files`;
	if (worse.length)
		return {
			status: "FAIL",
			secs: r.secs,
			note: `${scope}: new errors in ${worse
				.map(([f]) => f)
				.slice(0, 3)
				.join(", ")}${worse.length > 3 ? ` +${worse.length - 3}` : ""}`,
		};
	if (total && strict)
		return {
			status: "FAIL",
			secs: r.secs,
			note: `${scope}: ${total} baseline errors (--strict)`,
		};
	return {
		status: total ? "KNOWN" : "PASS",
		secs: r.secs,
		note: `${scope}: ${total} errors, none above baseline${better.length ? `; ${better.length} files improved` : ""}`,
	};
}

// ---- dev server ---------------------------------------------------------------------------
let server = null;
async function ensureServer() {
	const given = opt("url");
	if (given) return given.replace(/\/$/, "");
	let port = Number(opt("port", 3130));
	let url = `http://localhost:${port}`;
	const up = async () => {
		try {
			const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
			return r.status < 500;
		} catch {
			return false;
		}
	};
	if (await up()) {
		// Not ours (we have not started anything yet): another run may own it and kill it when it
		// finishes, so never share it; take the next free port and start our own server.
		const free = (p) =>
			new Promise((ok) => {
				const s = createServer();
				s.once("error", () => ok(false));
				s.listen(p, () => s.close(() => ok(true)));
			});
		const was = port;
		do port++;
		while (!(await free(port)) && port < was + 50);
		url = `http://localhost:${port}`;
		console.log(
			`[ci] :${was} is in use by another server; using :${port} instead`,
		);
	}
	console.log(
		`[ci] starting vite dev on :${port} (own dep cache node_modules/.vite-${port})`,
	);
	server = spawn(
		"npx",
		["vite", "dev", "--port", String(port), "--strictPort"],
		{
			cwd: ROOT,
			env: { ...process.env, FORCE_COLOR: "0" },
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	groups.add(server.pid);
	let slog = "";
	server.stdout.on("data", (b) => {
		slog += b;
	});
	server.stderr.on("data", (b) => {
		slog += b;
	});
	server.on("close", () => writeFileSync(join(LOGS, "dev-server.log"), slog));
	for (let t = 0; t < 180; t += 2) {
		if (server.exitCode != null) break;
		if (await up()) {
			// warm the SSR + route transforms once so the first browser check doesn't pay for them
			// (an HTTP fetch, not a page open: no engine runs, so no ?renderer= is needed)
			await fetch(`${url}/photo/IMG_7086`).catch(() => {});
			return url;
		}
		await new Promise((r) => setTimeout(r, 2000));
	}
	writeFileSync(join(LOGS, "dev-server.log"), slog);
	throw new Error(
		`dev server on :${port} did not come up (see out/ci/logs/dev-server.log)`,
	);
}
function stopServer() {
	if (!server || server.exitCode != null) return;
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch {}
}
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		killGroups("SIGTERM");
		stopServer();
		process.exit(sig === "SIGINT" ? 130 : 143);
	});
}

// ---- one check ----------------------------------------------------------------------------
async function runCheck(c, url) {
	const missing = (c.needs ?? []).filter((p) => !existsSync(join(ROOT, p)));
	if (missing.length)
		return { status: "SKIP", secs: 0, note: `missing ${missing.join(", ")}` };
	if (c.builtin === "biome") return runBiome(c);
	const sub = (s) => s.replaceAll("{url}", url ?? "");
	const env = Object.fromEntries(
		Object.entries(c.env ?? {}).map(([k, v]) => [k, sub(v)]),
	);
	let r;
	for (let attempt = 0; attempt <= (c.retries ?? 0); attempt++) {
		if (attempt)
			console.log(`[ci] ${c.id} crashed (exit ${r.code}); retry ${attempt}`);
		r = await run(c.cmd.map(sub), {
			env,
			timeoutS: c.timeoutS,
			log: join(LOGS, `${c.id}${attempt ? `.retry${attempt}` : ""}.log`),
		});
		if (r.code === 0 && !r.timedOut) break;
	}
	const ctx = { baseline, isCI, strict, code: r.code };
	let reason = null;
	if (r.timedOut) reason = `timeout after ${c.timeoutS}s`;
	else if (r.code !== 0 && !c.gateOwnsExit)
		reason = `exit ${r.code}: ${firstError(r.out)}`;
	else if (c.failIf?.test(r.out)) reason = `output matched ${c.failIf}`;
	else if (c.gate) reason = c.gate(r.out, ctx);
	const res = {
		secs: r.secs,
		metrics: ctx.metrics,
		note:
			reason ??
			ctx.known ??
			(ctx.metrics ? JSON.stringify(ctx.metrics) : lastLine(r.out)),
	};
	const known = isKnown(c.id);
	// advisory check (no baseline key yet): every failure, exit code and timeout included, is KNOWN
	const advisory = !!c.advisoryUntil && baseline[c.advisoryUntil] == null;
	if (reason && advisory)
		res.note = `advisory (no ${c.advisoryUntil} baseline): ${res.note}`;
	if (!reason) res.status = ctx.known ? "KNOWN" : known ? "FIXED" : "PASS";
	else res.status = (known || advisory) && !strict ? "KNOWN" : "FAIL";
	return res;
}

// ---- main ---------------------------------------------------------------------------------
const t0 = Date.now();
const results = new Map();
const fast = selected.filter((c) => !c.browser);
const slow = selected.filter((c) => c.browser);
console.log(
	`[ci] tier ${tier}: ${selected.length} checks (${fast.length} parallel ×${jobs}, ${slow.length} browser under the render lock)`,
);

const queue = [...fast];
await Promise.all(
	Array.from({ length: Math.min(jobs, queue.length) }, async () => {
		for (let c = queue.shift(); c; c = queue.shift()) {
			const r = await runCheck(c);
			results.set(c.id, r);
			console.log(`[ci] ${r.status.padEnd(5)} ${c.id} (${r.secs.toFixed(1)}s)`);
		}
	}),
);

if (slow.length) {
	let url = null;
	const needServer = slow.some((c) =>
		(c.needs ?? []).every((p) => existsSync(join(ROOT, p))),
	);
	try {
		if (needServer) url = await ensureServer();
	} catch (e) {
		for (const c of slow)
			results.set(c.id, {
				status: "FAIL",
				secs: 0,
				note: String(e.message ?? e),
			});
	}
	if (url || !needServer)
		for (const c of slow) {
			console.log(
				`[ci] running ${c.id} (waits for the render lock if another job holds it)…`,
			);
			const r = await runCheck(c, url);
			results.set(c.id, r);
			console.log(`[ci] ${r.status.padEnd(5)} ${c.id} (${r.secs.toFixed(1)}s)`);
		}
	stopServer();
}

// ---- report -------------------------------------------------------------------------------
const rows = selected.map((c) => ({
	id: c.id,
	tier: c.tier,
	group: c.group,
	...results.get(c.id),
}));
const w = Math.max(...rows.map((r) => r.id.length), 5);
console.log(`\n${"check".padEnd(w)}  tier  status  time    note`);
console.log(`${"-".repeat(w)}  ----  ------  ------  ${"-".repeat(40)}`);
for (const r of rows)
	console.log(
		`${r.id.padEnd(w)}  ${r.tier.padEnd(4)}  ${r.status.padEnd(6)}  ${`${r.secs.toFixed(1)}s`.padStart(6)}  ${r.note ?? ""}`,
	);
const count = (s) => rows.filter((r) => r.status === s).length;
const failed = count("FAIL");
const total = ((Date.now() - t0) / 1000).toFixed(1);
console.log(
	`\n${failed ? "GATE FAILED" : "GATE PASSED"}: ${count("PASS")} pass, ${failed} fail, ${count("KNOWN")} known, ${count("FIXED")} fixed, ${count("SKIP")} skipped — ${total}s (logs: out/ci/logs/)`,
);
if (count("FIXED"))
	console.log(
		"FIXED checks pass now: remove them from scripts/ci/known-failures.json (and the README table).",
	);

writeFileSync(
	join(OUT, "last-run.json"),
	JSON.stringify(
		{
			at: new Date().toISOString(),
			tier,
			biomeScope,
			strict,
			totalSecs: Number(total),
			rows,
		},
		null,
		1,
	),
);

if (updateBaseline) {
	const b = structuredClone(baseline);
	const bio = CHECKS.find((c) => c.id === "biome");
	if (bio.biomeErrors && biomeScope === "all")
		b.biome = { errors: bio.biomeErrors };
	else if (bio.biomeErrors)
		console.log("[ci] biome baseline only updates from --biome all");
	// eval-app minima: observed − EVAL_NOISE (run-to-run noise), merged into the existing entry so
	// hand-written fields (note, …) survive; lastObserved records the raw run.
	const EVAL_NOISE = 1;
	const day = new Date().toISOString().slice(0, 10);
	for (const [id, key] of [
		["eval-app", "evalApp"],
		["eval-app-deck", "evalAppDeck"],
	]) {
		const m = results.get(id)?.metrics;
		if (!m) continue;
		b[key] = {
			...b[key],
			minWithin1deg: Math.max(0, m.within1deg - EVAL_NOISE),
			of: m.of,
			lastObserved: `${m.within1deg}/${m.of} within 1° yaw, median ${m.medianAutoPx} px (${day})`,
		};
		delete b[key].medianAutoPx;
		console.log(
			`[ci] ${key}.minWithin1deg = ${b[key].minWithin1deg} (observed ${m.within1deg}/${m.of} − ${EVAL_NOISE})`,
		);
	}
	b.updated = new Date().toISOString().slice(0, 10);
	writeFileSync(BASELINE_FILE, `${JSON.stringify(b, null, "\t")}\n`);
	console.log(`[ci] wrote ${BASELINE_FILE}`);
}

process.exit(failed ? 1 : 0);
