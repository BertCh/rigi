#!/usr/bin/env node
// GA0 flag A/B on the app's auto-alignment (a copy of scripts/eval-app.mjs with flag overrides; rules in
// tools/research/geo/PROTOCOL.txt "GA0 - Agent A"). Runs every control-point photo twice on the SAME
// harness, flags off (arm A) and with the given flags on (arm B, via globalThis.__RIGI_FLAGS__ in an init
// script), and compares per photo. Holdout GT ids are REFUSED (the GEO rule); dev GT + non-GT photos only.
//
//   APP_URL=http://localhost:8792 node scripts/gpu/with-render-lock.mjs -- \
//     node scripts/geocam/eval-app-flags.mjs --flags geoDecl=on,geoLakeFloor=on,geoLakes=on [--live]
//     [--renderer three|deck] [IMG_x …]
// --renderer pins the engine for both arms (?renderer=); without it the app default runs. Each row records
// the engine that actually ran (engine: __engine.kind ?? "three"; "webgpu" when __engine.backend is "webgpu").
//
// Overpass water queries are answered from the union of the cached out/concord/pins/osm/*_water.json
// (deterministic; --live lets them through). Needs a dev server (APP_URL; never the shared :3100).
// Writes out/geocam/ga0/eval-app-flags[-live].json. Exit 1 on a regression (protocol rule (2)).
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const BASE = process.env.APP_URL;
if (!BASE || /:(3000|3100|8765|8766|8767|8768)\b/.test(BASE)) {
	console.error("set APP_URL to a private dev server (not a shared live port)");
	process.exit(2);
}
const HOLDOUT = ["IMG_6019", "IMG_6958", "IMG_7086", "IMG_7130"];
const args = process.argv.slice(2);
const flagArg = args.includes("--flags")
	? args[args.indexOf("--flags") + 1]
	: "geoDecl=on,geoLakeFloor=on,geoLakes=on";
const live = args.includes("--live");
const rendererEq = args.find((a) => a.startsWith("--renderer="));
const renderer = rendererEq
	? rendererEq.slice(11)
	: args.includes("--renderer")
		? args[args.indexOf("--renderer") + 1]
		: null;
if (renderer != null && !["three", "deck"].includes(renderer)) {
	console.error(`--renderer must be three or deck (got ${renderer})`);
	process.exit(2);
}
const rendererQuery = renderer ? `?renderer=${renderer}` : "";
const only = args.filter(
	(a, i) => a.startsWith("IMG_") && args[i - 1] !== "--flags",
);
for (const id of only)
	if (HOLDOUT.includes(id)) {
		console.error(`${id} is a HOLDOUT photo: GEO evals are dev-only`);
		process.exit(2);
	}
const flags = Object.fromEntries(
	flagArg
		.split(",")
		.filter(Boolean)
		.map((kv) => kv.split("=")),
);
for (const k of Object.keys(flags))
	if (!k.startsWith("geo")) {
		console.error(`only geo* flags here (got ${k})`);
		process.exit(2);
	}

const cps = JSON.parse(
	fs.readFileSync(path.join(ROOT, "data", "control-points.json"), "utf8"),
);
const ids = Object.keys(cps).filter(
	(id) => !HOLDOUT.includes(id) && (!only.length || only.includes(id)),
);
const refused = Object.keys(cps).filter((id) => HOLDOUT.includes(id));

// cached water union
const osmDir = path.join(ROOT, "out", "concord", "pins", "osm");
const seen = new Set();
const water = [];
for (const f of fs.readdirSync(osmDir).filter((f) => f.endsWith("_water.json")))
	for (const e of JSON.parse(fs.readFileSync(path.join(osmDir, f), "utf8"))
		.elements) {
		const k = `${e.type}/${e.id}`;
		if (seen.has(k)) continue;
		seen.add(k);
		water.push(e);
	}
const waterBody = JSON.stringify({ version: 0.6, elements: water });

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});

async function runArm(arm, armFlags) {
	const rows = [];
	await Promise.all(
		ids.map(async (id) => {
			const page = await browser.newPage({
				viewport: { width: 1400, height: 900 },
			});
			const logs = [];
			let overpassWater = 0;
			let overpassOther = 0;
			page.on("console", (m) => {
				const t = m.text();
				if (t.startsWith("[geo]")) logs.push(t);
			});
			await page.route("**/api/interpreter**", async (route) => {
				const q =
					new URLSearchParams(route.request().postData() ?? "").get("data") ??
					"";
				if (/natural"="water/.test(q)) {
					overpassWater++;
					if (!live)
						return route.fulfill({
							status: 200,
							contentType: "application/json",
							body: waterBody,
						});
				} else overpassOther++;
				return route.continue();
			});
			await page.addInitScript((f) => {
				localStorage.clear();
				if (Object.keys(f).length)
					globalThis.__RIGI_FLAGS__ = { ...globalThis.__RIGI_FLAGS__, ...f };
			}, armFlags);
			await page.goto(`${BASE}/photo/${id}${rendererQuery}`);
			await page.waitForSelector("[data-ready]", {
				state: "attached",
				timeout: 180000,
			});
			await page.waitForFunction(
				() =>
					document
						.querySelector("[data-ready]")
						?.getAttribute("data-verify") !== "pending",
				null,
				{ timeout: 180000 },
			);
			const r = await page.evaluate((cp) => {
				const e = window.__engine;
				const pins = e.controlPins(cp);
				const n = pins.length;
				const gt = e.solvePins(pins, e.prior, cp.solveFocal !== false);
				const auto = e.pose;
				const d = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;
				return {
					engine: e.backend === "webgpu" ? "webgpu" : (e.kind ?? "three"),
					pins: n,
					gtResid: e.pinError(gt, pins, cp.basis).mean,
					priorErr: e.pinError(e.prior, pins, cp.basis).mean,
					autoErr: e.pinError(auto, pins, cp.basis).mean,
					dYawPrior: d(e.prior.yaw, gt.yaw),
					dYawAuto: d(auto.yaw, gt.yaw),
					dPitchAuto: auto.pitch - gt.pitch,
					dRollAuto: auto.roll - gt.roll,
					priorYaw: e.prior.yaw,
					autoYaw: auto.yaw,
					eyeAlt: e.eyeAlt,
					demAtCamera: e.demAtCamera,
				};
			}, cps[id]);
			rows.push({ id, arm, ...r, geoLogs: logs, overpassWater, overpassOther });
			await page.close();
		}),
	);
	rows.sort((a, b) => a.id.localeCompare(b.id));
	return rows;
}

const f = (x, n = 2) => (Number.isFinite(x) ? x.toFixed(n) : "∞");
const summarise = (rows) => {
	const scored = rows.filter((r) => r.pins > 0);
	const ok = scored.filter((r) => Math.abs(r.dYawAuto) < 1);
	const px = rows.map((r) => r.autoErr).sort((a, b) => a - b);
	return {
		within1: ok.length,
		scored: scored.length,
		medianPx: px[px.length >> 1] ?? Number.NaN,
	};
};

const A = await runArm("off", {});
const B = await runArm("on", flags);
await browser.close();
const engines = [...new Set([...A, ...B].map((r) => r.engine))];
if (renderer && engines.some((k) => k !== renderer)) {
	console.error(
		`--renderer ${renderer} asked for, but engines ran: ${engines.join(",")}`,
	);
	process.exit(2);
}

console.log(
	`engine: ${engines.join(",")}${renderer ? " (pinned)" : " (app default)"}; flags: ${JSON.stringify(flags)}; water: ${live ? "LIVE Overpass" : "cached union"}; refused holdout: ${refused.join(" ")}`,
);
console.log(
	"photo     pins  auto-px(off) auto-px(on)  Δyaw(off)  Δyaw(on)  eye(off)   eye(on)   prior yaw off→on   geo log",
);
const changed = [];
const regressions = [];
for (const a of A) {
	const b = B.find((r) => r.id === a.id);
	const dy = Math.abs(a.autoYaw - b.autoYaw);
	const diff =
		dy >= 0.005 ||
		Math.abs(a.autoErr - b.autoErr) > 0.05 ||
		Math.abs(a.eyeAlt - b.eyeAlt) > 1e-6 ||
		Math.abs(a.priorYaw - b.priorYaw) > 1e-9;
	if (diff) changed.push(a.id);
	if (Math.abs(a.dYawAuto) < 1 && !(Math.abs(b.dYawAuto) < 1))
		regressions.push(`${a.id}: within 1° off, not on`);
	console.log(
		`${a.id}  ${String(a.pins).padStart(3)}  ${f(a.autoErr, 1).padStart(11)} ${f(b.autoErr, 1).padStart(11)}  ${f(a.dYawAuto).padStart(9)} ${f(b.dYawAuto).padStart(9)}  ${f(a.eyeAlt, 1).padStart(8)} ${f(b.eyeAlt, 1).padStart(9)}   ${f(a.priorYaw)}→${f(b.priorYaw)}   ${b.geoLogs.join(" | ")}`,
	);
}
const sa = summarise(A);
const sb = summarise(B);
if (sb.within1 < sa.within1) regressions.push("count within 1° dropped");
if (sb.medianPx > sa.medianPx + 0.5) regressions.push("median px +0.5");
console.log(
	`\noff: ${sa.within1}/${sa.scored} within 1° yaw; median auto px error ${f(sa.medianPx, 1)}`,
);
console.log(
	`on:  ${sb.within1}/${sb.scored} within 1° yaw; median auto px error ${f(sb.medianPx, 1)}`,
);
console.log(
	`changed photos: ${changed.length ? changed.join(" ") : "none"}; regressions: ${regressions.length ? regressions.join("; ") : "none"}`,
);
const outFile = path.join(
	ROOT,
	"out",
	"geocam",
	"ga0",
	`eval-app-flags${live ? "-live" : ""}.json`,
);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(
	outFile,
	JSON.stringify(
		{
			format: "geocam-ga0-eval-app-flags/1",
			created: new Date().toISOString(),
			base: BASE,
			renderer: renderer ?? "app-default",
			engines,
			flags,
			water: live ? "live" : "cached-union",
			refused,
			summary: { off: sa, on: sb, changed, regressions },
			rows: [...A, ...B],
		},
		null,
		1,
	),
);
process.exit(regressions.length ? 1 : 0);
