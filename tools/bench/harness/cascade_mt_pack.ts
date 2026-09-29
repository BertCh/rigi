/**
 * Cascade-on-Mapterhorn follow-up: (a) a new cascade pose inherits an existing verify_v2 cluster when it
 * is within 0.5° yaw and 0.5° pitch of that cluster's pose and its eye is within 2 m of the cluster's
 * drawn eye (mechanical match on key_v2.json; verdicts are never read); (b) the rest get a blinded pack
 * (one candidate per photo, a random letter, no method or confidence shown), drawn on Mapterhorn at the
 * cascade's own eye (0f's eyeHeight on 0f's MAPTERHORN ground, as recorded in the row).
 *
 *   npx tsx tools/bench/harness/cascade_mt_pack.ts [--run runs/wild-cascade-mt] [--v2 runs/wild/verify_v2/key_v2.json]
 *   → <run>/inherit.json, <run>/verify/{<id>_<L>.jpg, index.json, key.json}
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HARNESS, prefetchPeaksBBox, ROOT } from "./lib/geo";
import type { Pose } from "../../../src/lib/camera";
import { renderOverlay } from "./overlay";

const argv = process.argv.slice(2);
const arg = (k: string, d: string) =>
	argv.includes(k) ? argv[argv.indexOf(k) + 1] : d;
const run = path.resolve(HARNESS, "out", arg("--run", "runs/wild-cascade-mt"));
const v2 = JSON.parse(
	fs.readFileSync(
		path.resolve(
			HARNESS,
			"out",
			arg("--v2", "runs/wild/verify_v2/key_v2.json"),
		),
		"utf8",
	),
);
const TOL_DEG = 0.5;
const TOL_EYE = 2;
const dang = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;

function rng(seed: string) {
	let h = crypto.createHash("sha256").update(seed).digest().readUInt32LE(0);
	return () => {
		h = (h + 0x6d2b79f5) >>> 0;
		let t = h;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

type Row = {
	id: string;
	method: string;
	condition: string;
	ok: boolean;
	error?: string;
	pose?: Pose;
	eye?: number;
	eyeGround?: number;
	dem?: string;
	confidence?: number;
	accepted?: boolean;
	acceptKind?: string;
	ms?: number;
};

async function main() {
	const rows: Row[] = JSON.parse(
		fs.readFileSync(path.join(run, "results.json"), "utf8"),
	).filter((r: Row) => r.method === "cascade" && r.condition === "given");
	const manifest = JSON.parse(
		fs.readFileSync(path.join(ROOT, "tools/bench/data/manifest.json"), "utf8"),
	) as {
		id: string;
		file: string;
		lat: number;
		lon: number;
		altitudeM?: number | null;
	}[];
	const byId = new Map(manifest.map((e) => [e.id, e]));
	const inherit: Record<string, unknown> = {};
	const todo: Row[] = [];
	for (const r of rows.sort((a, b) => a.id.localeCompare(b.id))) {
		if (!r.ok || !r.pose || typeof r.eye !== "number") {
			inherit[r.id] = { inherits: null, reason: `no pose: ${r.error ?? "?"}` };
			continue;
		}
		const cl = Object.entries<{
			pose: Pose;
			eye?: { h: number };
			methods: { method: string }[];
		}>(v2[r.id]?.clusters ?? {}).filter(([L]) => L !== "P");
		let best: {
			L: string;
			dy: number;
			dp: number;
			de: number;
			methods: string[];
		} | null = null;
		for (const [L, c] of cl) {
			const dy = dang(r.pose.yaw, c.pose.yaw);
			const dp = r.pose.pitch - c.pose.pitch;
			const de = c.eye ? r.eye - c.eye.h : Number.NaN;
			if (
				Math.abs(dy) <= TOL_DEG &&
				Math.abs(dp) <= TOL_DEG &&
				Math.abs(de) <= TOL_EYE
			) {
				if (!best || Math.hypot(dy, dp) < Math.hypot(best.dy, best.dp))
					best = { L, dy, dp, de, methods: c.methods.map((m) => m.method) };
			}
		}
		if (best)
			inherit[r.id] = {
				inherits: best.L,
				clusterMethods: best.methods,
				dYaw: best.dy,
				dPitch: best.dp,
				dEyeM: best.de,
				accepted: r.accepted,
				confidence: r.confidence,
			};
		else {
			inherit[r.id] = {
				inherits: null,
				reason: "no v2 cluster within 0.5°/0.5°/2 m",
				accepted: r.accepted,
				confidence: r.confidence,
			};
			todo.push(r);
		}
	}
	fs.writeFileSync(
		path.join(run, "inherit.json"),
		JSON.stringify(
			{
				about:
					"new cascade (Mapterhorn, 0f loader) pose → verify_v2 cluster label it inherits (|Δyaw|,|Δpitch| ≤ 0.5°, |Δeye| ≤ 2 m), else null → see verify/",
				tolerance: { deg: TOL_DEG, eyeM: TOL_EYE },
				photos: inherit,
			},
			null,
			1,
		),
	);
	const out = path.join(run, "verify");
	fs.mkdirSync(out, { recursive: true });
	const lats = manifest.map((e) => e.lat);
	const lons = manifest.map((e) => e.lon);
	const mLon =
		0.8 / Math.cos((Math.max(...lats.map(Math.abs)) * Math.PI) / 180);
	await prefetchPeaksBBox(
		+(Math.min(...lats) - 0.8).toFixed(2),
		+(Math.min(...lons) - mLon).toFixed(2),
		+(Math.max(...lats) + 0.8).toFixed(2),
		+(Math.max(...lons) + mLon).toFixed(2),
	);
	const key: Record<string, unknown> = {};
	const index: Record<string, unknown> = {};
	for (const r of todo) {
		const e = byId.get(r.id);
		if (!e) continue;
		const L = "ABCDE"[Math.floor(rng(`summit-lens-cascade-mt:${r.id}`)() * 5)];
		const file = `${r.id}_${L}.jpg`;
		const photoFile = path.resolve(ROOT, "tools/bench/data", e.file);
		const ov = await renderOverlay({
			photoFile,
			lat: e.lat,
			lon: e.lon,
			alt: e.altitudeM ?? null,
			eyeH: r.eye as number,
			pose: r.pose as Pose,
			title: r.id,
			method: `candidate ${L}`,
			width: 1400,
			out: path.join(out, file),
		});
		key[r.id] = {
			[L]: {
				method: "cascade (Mapterhorn, 0f loader)",
				pose: r.pose,
				confidence: r.confidence,
				accepted: r.accepted,
				acceptKind: r.acceptKind,
				eye: {
					h: r.eye,
					ground0f: r.eyeGround,
					dem: r.dem,
					overlayDem: ov.dem,
					overlayGround: ov.ground,
				},
			},
		};
		index[r.id] = {
			photo: path.relative(out, photoFile),
			candidates: { [L]: file },
		};
		console.error(`[cascade-mt] ${r.id}: ${L}`);
	}
	fs.writeFileSync(path.join(out, "key.json"), JSON.stringify(key, null, 1));
	fs.writeFileSync(
		path.join(out, "index.json"),
		JSON.stringify(
			{
				about:
					"Blinded candidates (one per photo). Each overlay draws the Mapterhorn DEM skyline (yellow) and occlusion-tested OSM peak labels for a candidate camera pose; judge whether the yellow line lies on the photo's real skyline and the labels on the right peaks.",
				photos: index,
			},
			null,
			1,
		),
	);
	const nInh = Object.values(inherit).filter(
		(x) => (x as { inherits: string | null }).inherits,
	).length;
	console.log(
		JSON.stringify({
			rows: rows.length,
			inherit: nInh,
			needVerify: todo.length,
			failed: rows.length - nInh - todo.length,
			accepted: rows.filter((r) => r.ok && r.accepted).length,
			out,
		}),
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
