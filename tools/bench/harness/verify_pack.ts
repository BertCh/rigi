/**
 * Blinded verification pack for a harness run: per photo, the methods' solved poses are clustered
 * (same cluster = within 0.5° yaw and 0.5° pitch of a member) and one overlay is rendered per
 * cluster, labelled only "A", "B", "C" in a per-photo random order: no method name, no confidence.
 * A prior overlay "P" (manifest heading, pitch = roll = 0) is added when the photo has a heading.
 *
 *   npx tsx tools/bench/harness/verify_pack.ts <manifest.json> <run dir> [--methods app,cascade,fused]
 *       [--out-name verify] [--key-name key.json] [--salt ""] [--from-key <v1 key.json>]
 *   → <run dir>/<out-name>/{<id>_<L>.jpg, index.json (for verifiers), <key-name> (scoring only), stats.json}
 * Each candidate is drawn on the Mapterhorn DEM at the eye its method used (row.eye: fused/app = the
 * engine eye, ENU z; cascade = its own eyeHeight). A cluster that merges methods is drawn at the fused
 * eye if a member is fused, else the app eye (recorded as eyeNote in the key). --from-key reuses a
 * previous pack's cluster membership (asserted equal to the recomputed one) with fresh labels (--salt).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { prefetchPeaksBBox } from "./lib/geo";
import type { Pose } from "../../../src/lib/camera";
import { renderOverlay } from "./overlay";

type Row = {
	id: string;
	method: string;
	ok: boolean;
	error?: string;
	pose?: Pose | null;
	confidence?: number | null;
	confidenceLevel?: string;
	accepted?: boolean;
	acceptKind?: string;
	eye?: number | number[] | null;
	dem?: string;
	eyeGround?: number;
	ms?: number;
	assumptions?: { vfov: number; yawHint?: number | null; yaw?: number | null };
};

const dang = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;
const TOL = 0.5;
const EYE_PREF = ["fused", "app", "cascade"];
/** Absolute eye (m) usable on Mapterhorn; null = recompute with the method's rule (cascade rows solved on
 * Terrarium: their eye sits on a different ground, up to ~40 m off, so their eyeHeight rule is re-applied). */
const eyeOf = (r: Row) =>
	Array.isArray(r.eye)
		? r.eye[2]
		: typeof r.eye === "number" &&
				(r.method !== "cascade" || r.dem === "mapterhorn")
			? r.eye
			: null;

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

function meanPose(ps: Pose[]): Pose {
	const y0 = ps[0].yaw;
	const yaw = y0 + ps.reduce((s, p) => s + dang(p.yaw, y0), 0) / ps.length;
	const avg = (k: keyof Pose) => ps.reduce((s, p) => s + p[k], 0) / ps.length;
	return {
		yaw: ((yaw % 360) + 360) % 360,
		pitch: avg("pitch"),
		roll: avg("roll"),
		vfov: avg("vfov"),
	};
}

async function main() {
	const argv = process.argv.slice(2);
	const [manifestPath, runDir] = argv;
	const mi = argv.indexOf("--methods");
	const methods =
		mi >= 0 ? argv[mi + 1].split(",") : ["app", "cascade", "fused"];
	const arg = (k: string, d: string) =>
		argv.includes(k) ? argv[argv.indexOf(k) + 1] : d;
	const outName = arg("--out-name", "verify");
	const keyName = arg("--key-name", "key.json");
	const salt = arg("--salt", "");
	const fromKey = argv.includes("--from-key")
		? JSON.parse(fs.readFileSync(arg("--from-key", ""), "utf8"))
		: null;
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	const entries: {
		id: string;
		file: string;
		lat: number;
		lon: number;
		altitudeM?: number | null;
		headingDeg?: number | null;
	}[] = Array.isArray(manifest) ? manifest : manifest.photos;
	const rows: Row[] = JSON.parse(
		fs.readFileSync(path.join(runDir, "results.json"), "utf8"),
	).filter((r: Row & { condition: string }) => r.condition === "given");
	const out = path.join(runDir, outName);
	fs.mkdirSync(out, { recursive: true });
	// same bbox as run.ts → the cached Overpass answer, no new query
	const lats = entries.map((e) => e.lat);
	const lons = entries.map((e) => e.lon);
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
	const hist: Record<string, number> = {};
	const safe = (id: string) => id.replace(/[^\w.-]/g, "_");
	for (const e of entries) {
		const mine = rows.filter(
			(r) => r.id === e.id && methods.includes(r.method),
		);
		const norm = path.join(runDir, "photos", `${safe(e.id)}.jpg`);
		const photoFile = fs.existsSync(norm)
			? norm
			: path.resolve(path.dirname(manifestPath), e.file);
		// cluster (single link, in a fixed method order)
		const clusters: { members: Row[] }[] = [];
		const failed: Row[] = [];
		for (const m of methods) {
			const r = mine.find((x) => x.method === m);
			if (!r || !r.ok || !r.pose) {
				failed.push(
					r ?? { id: e.id, method: m, ok: false, error: "no result" },
				);
				continue;
			}
			const p = r.pose;
			const c = clusters.find((cl) =>
				cl.members.some(
					(x) =>
						Math.abs(dang((x.pose as Pose).yaw, p.yaw)) <= TOL &&
						Math.abs((x.pose as Pose).pitch - p.pitch) <= TOL,
				),
			);
			if (c) c.members.push(r);
			else clusters.push({ members: [r] });
		}
		if (fromKey) {
			const sig = (ms: string[]) => [...ms].sort().join("+");
			const prev = Object.entries(fromKey[e.id]?.clusters ?? {})
				.filter(([L]) => L !== "P")
				.map(([, c]) =>
					sig(
						(c as { methods: { method: string }[] }).methods.map(
							(m) => m.method,
						),
					),
				)
				.sort();
			const now = clusters
				.map((c) => sig(c.members.map((m) => m.method)))
				.sort();
			if (JSON.stringify(prev) !== JSON.stringify(now))
				throw new Error(
					`${e.id}: cluster membership differs from --from-key (${prev} vs ${now})`,
				);
		}
		const k = `${clusters.length}${failed.length ? `+${failed.length}failed` : ""}`;
		hist[k] = (hist[k] ?? 0) + 1;
		// blind labels
		const rand = rng(`summit-lens-verify${salt}:${e.id}`);
		const order = clusters
			.map((c) => ({ c, r: rand() }))
			.sort((a, b) => a.r - b.r);
		const files: Record<string, string> = {};
		const kc: Record<string, unknown> = {};
		const labels = ["A", "B", "C", "D"];
		for (let i = 0; i < order.length; i++) {
			const L = labels[i];
			const members = order[i].c.members;
			const pose = meanPose(members.map((x) => x.pose as Pose));
			const f = `${safe(e.id)}_${L}.jpg`;
			const drawn = [...members].sort(
				(a, b) => EYE_PREF.indexOf(a.method) - EYE_PREF.indexOf(b.method),
			)[0];
			const eyeH = eyeOf(drawn);
			const eyes = members.map((x) => ({
				method: x.method,
				eye: eyeOf(x) ?? (typeof x.eye === "number" ? x.eye : null),
			}));
			const spread = eyes
				.filter((x) => x.eye != null)
				.map((x) => x.eye as number);
			const eyeNote =
				members.length > 1 &&
				spread.length > 1 &&
				Math.max(...spread) - Math.min(...spread) > 0.5
					? `merged methods with different eyes (${eyes.map((x) => `${x.method} ${x.eye?.toFixed(1)} m`).join(", ")}); drawn at the ${drawn.method} eye`
					: undefined;
			const ov = await renderOverlay({
				photoFile,
				lat: e.lat,
				lon: e.lon,
				alt: e.altitudeM ?? null,
				eyeH,
				eyeRule: drawn.method === "cascade" ? "0f" : "app",
				pose,
				title: e.id,
				method: `candidate ${L}`,
				width: 1400,
				out: path.join(out, f),
			});
			files[L] = f;
			kc[L] = {
				pose,
				eye: {
					h: ov.eye,
					from:
						eyeH != null
							? `${drawn.method} row eye`
							: drawn.method === "cascade"
								? "cascade rule max(GPS, DEM+1.6) re-applied on Mapterhorn"
								: "app rule on Mapterhorn",
					dem: ov.dem,
					ground: ov.ground,
					...(drawn.method === "cascade" && eyeH == null
						? {
								cascadeSolvedEye:
									typeof drawn.eye === "number" ? drawn.eye : null,
								cascadeSolvedDem: drawn.dem ?? "terrarium",
							}
						: {}),
					...(eyeNote ? { note: eyeNote } : {}),
				},
				methods: order[i].c.members.map((x) => ({
					method: x.method,
					pose: x.pose,
					confidence: x.confidence ?? null,
					confidenceLevel: x.confidenceLevel ?? null,
					accepted: x.accepted ?? null,
					acceptKind: x.acceptKind ?? null,
				})),
			};
		}
		let prior: string | null = null;
		const vfov = mine.find((x) => x.assumptions)?.assumptions?.vfov;
		if (e.headingDeg != null && vfov) {
			prior = `${safe(e.id)}_P.jpg`;
			const pose = { yaw: e.headingDeg, pitch: 0, roll: 0, vfov };
			const pr = EYE_PREF.map((m) =>
				mine.find((x) => x.method === m && x.ok),
			).find((x) => x && eyeOf(x) != null);
			await renderOverlay({
				photoFile,
				lat: e.lat,
				lon: e.lon,
				alt: e.altitudeM ?? null,
				eyeH: pr ? eyeOf(pr) : null,
				pose,
				title: e.id,
				method: "prior P (manifest heading, level camera)",
				width: 1400,
				out: path.join(out, prior),
			});
			kc.P = {
				pose,
				methods: [{ method: "prior (manifest heading, pitch = roll = 0)" }],
			};
		}
		key[e.id] = {
			clusters: kc,
			failed: failed.map((r) => ({ method: r.method, error: r.error ?? null })),
		};
		index[e.id] = {
			photo: path.relative(out, photoFile),
			candidates: files,
			prior,
			note: prior ? undefined : "no heading in the manifest: no prior overlay",
		};
		console.error(
			`[verify] ${e.id}: ${clusters.length} cluster(s)${failed.length ? `, ${failed.length} failed` : ""}`,
		);
	}
	fs.writeFileSync(path.join(out, keyName), JSON.stringify(key, null, 1));
	fs.writeFileSync(
		path.join(out, "index.json"),
		JSON.stringify(
			{
				about:
					"Blinded candidates per photo. Each overlay draws the DEM skyline (yellow) and occlusion-tested OSM peak labels for one candidate camera pose; judge whether the yellow line lies on the photo's real skyline and the labels on the right peaks. P, when present, is the prior (manifest heading, level camera), for context only.",
				photos: index,
			},
			null,
			1,
		),
	);
	const stats = {
		photos: entries.length,
		clusterHistogram: hist,
		tolerance: { yawDeg: TOL, pitchDeg: TOL },
		methods,
	};
	fs.writeFileSync(
		path.join(out, "stats.json"),
		JSON.stringify(stats, null, 1),
	);
	console.log(JSON.stringify(stats));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
