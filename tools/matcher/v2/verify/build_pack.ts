/**
 * v2 blind verification pack (DEV ids only). Same protocol as tools/bench/final/addendum/build_pack.ts:
 * Mapterhorn overlay (tools/bench/harness/overlay.ts) at EXACTLY the eye in each candidate, neutral header
 * ("candidate K4": no pose numbers, eye, id, method or kind), random labels, random widths (duplicates are not
 * pixel-identical). Verifiers get <out>/pack/<pid>/{photo.jpg, candidate_*.jpg}; the key goes to <out>/key.json.
 *
 *   npx tsx tools/matcher/v2/verify/build_pack.ts <cands.json> <outDir>
 *   cands.json: [{pid, kind, pose:{yaw,pitch,roll,vfov}, eye:{lat,lon,h}}]   (kind is scoring-only)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { prefetchPeaksBBox } from "../../../bench/harness/lib/geo";
import { renderOverlay } from "../../../bench/harness/overlay";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url)).replace(
	/\/$/,
	"",
);
const [candFile, outDir] = process.argv.slice(2);
const OUT = path.resolve(outDir);
const PACK = path.join(OUT, "pack");
type Cand = {
	pid: string;
	kind: string;
	pose: Record<string, number>;
	eye: { lat: number; lon: number; h: number };
};
const cands: Cand[] = JSON.parse(fs.readFileSync(candFile, "utf8"));
const manifest = JSON.parse(
	fs.readFileSync(`${REPO}/tools/bench/data/manifest.json`, "utf8"),
);
const split = JSON.parse(
	fs.readFileSync(`${REPO}/tools/bench/split.json`, "utf8"),
);
for (const c of cands)
	if (split.test.includes(c.pid)) throw new Error(`test id refused: ${c.pid}`);
const seed = crypto.randomBytes(8).toString("hex");
let h = crypto.createHash("sha256").update(seed).digest().readUInt32LE(0);
const rand = () => {
	h = (h + 0x6d2b79f5) >>> 0;
	let t = h;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const used = new Set<string>();
const label = () => {
	for (;;) {
		const l =
			"ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(rand() * 24)] +
			(2 + Math.floor(rand() * 8));
		if (!used.has(l)) {
			used.add(l);
			return l;
		}
	}
};

// PACK_PAD=1 (round 2+): the overlay title bar covers the top ~7 % of the photo, which hid wc_0086's skyline in round 1.
// The photo is padded with equal black bands top and bottom (so the principal point stays centred) and the vfov is
// widened to match: vfov' = 2·atan(tan(vfov/2)·(H+2b)/H). Geometry is unchanged; the bar then covers only the pad.
const PAD = process.env.PACK_PAD === "1";
async function padded(src: string, dir: string) {
	const img = await loadImage(src);
	const b = Math.ceil((84 * img.width) / 1600);
	const c = createCanvas(img.width, img.height + 2 * b);
	const ctx = c.getContext("2d");
	ctx.fillStyle = "#000";
	ctx.fillRect(0, 0, img.width, img.height + 2 * b);
	ctx.drawImage(img, 0, b);
	const f = path.join(dir, `.padded_${path.basename(src)}`);
	fs.writeFileSync(f, await c.encode("jpeg", 95));
	return { file: f, k: (img.height + 2 * b) / img.height };
}
async function neutralHeader(file: string, text: string) {
	const img = await loadImage(file);
	const c = createCanvas(img.width, img.height);
	const ctx = c.getContext("2d");
	ctx.drawImage(img, 0, 0);
	const s = img.width / 1600;
	const header = Math.round(74 * s);
	ctx.fillStyle = "#000";
	ctx.fillRect(0, 0, img.width, header + 1);
	ctx.fillStyle = "#fff";
	ctx.font = `700 ${Math.round(30 * s)}px sans-serif`;
	ctx.fillText(text, 12 * s, 48 * s);
	fs.writeFileSync(file, await c.encode("jpeg", 90));
}

async function main() {
	fs.rmSync(PACK, { recursive: true, force: true });
	fs.mkdirSync(PACK, { recursive: true });
	const pids = [...new Set(cands.map((c) => c.pid))];
	for (const id of pids) {
		const e = manifest.find((m: { id: string }) => m.id === id);
		for (let a = 0; a < 6; a++) {
			try {
				await prefetchPeaksBBox(
					+(e.lat - 0.9).toFixed(2),
					+(e.lon - 1.3).toFixed(2),
					+(e.lat + 0.9).toFixed(2),
					+(e.lon + 1.3).toFixed(2),
				);
				break;
			} catch (err) {
				console.error("prefetch retry", String(err));
				await new Promise((r) => setTimeout(r, 15000));
			}
		}
	}
	const key: Record<string, unknown> = { seed, candidates: {} };
	const order = cands
		.map((c) => ({ c, r: rand() }))
		.sort((a, b) => a.r - b.r)
		.map((x) => x.c);
	for (const c of order) {
		const e = manifest.find((m: { id: string }) => m.id === c.pid);
		const dir = path.join(PACK, c.pid);
		fs.mkdirSync(dir, { recursive: true });
		fs.copyFileSync(
			path.join(REPO, "tools/bench/data", e.file),
			path.join(dir, "photo.jpg"),
		);
		const L = label();
		const width = [1360, 1400, 1440, 1480][Math.floor(rand() * 4)];
		const file = path.join(dir, `candidate_${L}.jpg`);
		for (let a = 0; ; a++) {
			try {
				let photoFile = path.join(REPO, "tools/bench/data", e.file);
				let pose = c.pose;
				if (PAD) {
					const pd = await padded(photoFile, OUT);
					photoFile = pd.file;
					pose = {
						...c.pose,
						vfov:
							(2 *
								Math.atan(Math.tan((c.pose.vfov * Math.PI) / 360) * pd.k) *
								180) /
							Math.PI,
					};
				}
				const ov = await renderOverlay({
					photoFile,
					lat: e.lat,
					lon: e.lon,
					alt: e.altitudeM ?? null,
					eyeLat: c.eye.lat,
					eyeLon: c.eye.lon,
					eyeH: c.eye.h,
					pose: pose as never,
					title: "x",
					method: "x",
					width,
					out: file,
				} as never);
				await neutralHeader(file, `candidate ${L}`);
				(key.candidates as Record<string, unknown>)[L] = {
					...c,
					eyeRendered: (ov as { eye: unknown }).eye,
					dem: (ov as { dem: unknown }).dem,
					width,
					labels: (ov as { labels: unknown }).labels,
				};
				console.error(
					c.pid,
					L,
					c.kind,
					JSON.stringify((ov as { eye: unknown }).eye),
				);
				break;
			} catch (err) {
				if (a >= 3) throw err;
				console.error("retry", err);
				await new Promise((r) => setTimeout(r, 3000));
			}
		}
	}
	fs.writeFileSync(path.join(OUT, "key.json"), JSON.stringify(key, null, 1));
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
