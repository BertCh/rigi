/**
 * WP-G evaluation: render → re-match loop on DEV photos (never holdout).
 *
 *   node scripts/gpu/with-render-lock.mjs -- npx tsx scripts/concord/rematch-eval.ts \
 *     [--photos IMG_7018,IMG_7033] [--pose app|gt] [--tiles 6] [--iterations 3] [--start-server]
 *
 * --start-server spawns tools/concord/rematch/server.py (matcher venv) on :8768 for the run and kills it
 * at the end; otherwise a running service is used. Writes out/concord/rematch/eval-<stamp>.json and
 * out/concord/rematch/cues/<photo>.json (inliers as WP-A "point" cues, GT scene frame).
 *
 * Reports per photo: iteration table (inliers, lower-half inliers, quadrants, bands, median px, latency),
 * the Python↔TS projection parity of every returned inlier, and the mask check: reprojection error of
 * the lifted points at the GT camera (pin-fitted reference) with the DTM lift vs the semantic lift/drop,
 * on building (village) and forest points within 5 km.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { projectX, type Vec3 } from "../../src/lib/concord/core";
import {
	inliersToCues,
	type RematchResult,
	rematch,
} from "../../src/lib/concord/match/client";
import { ROOT } from "../lib/node-io";
import {
	appSolve,
	baselineCam,
	basis1600,
	gtCam,
	loadScene,
	loadSplit,
	median,
} from "./lib";

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => {
	const i = args.indexOf(`--${k}`);
	return i >= 0 ? args[i + 1] : d;
};
const photos = (opt("photos", "IMG_7018,IMG_7033,IMG_7131") as string).split(
	",",
);
const poseMode = opt("pose", "app") as "app" | "gt";
const tiles = Number(opt("tiles", "6")) as 4 | 6;
const iterations = Number(opt("iterations", "3")) as 1 | 2 | 3;
const URL = opt("url", "http://localhost:8768") as string;
const OUT = path.join(ROOT, "out", "concord", "rematch");

const split = loadSplit();
for (const p of photos)
	if (split[p] !== "dev") {
		console.error(`${p}: not a DEV photo (split=${split[p]}); refusing`);
		process.exit(2);
	}

async function health(): Promise<boolean> {
	try {
		const r = await fetch(`${URL}/health`);
		return r.ok;
	} catch {
		return false;
	}
}

let server: ReturnType<typeof spawn> | null = null;
async function startServer() {
	const py = path.join(ROOT, "tools", "matcher", ".venv", "bin", "python");
	server = spawn(
		py,
		["-B", path.join(ROOT, "tools", "concord", "rematch", "server.py")],
		{ cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] },
	);
	const t0 = Date.now();
	while (!(await health())) {
		if (Date.now() - t0 > 180_000) throw new Error("server did not start");
		if (server.exitCode !== null) throw new Error("server exited");
		await new Promise((r) => setTimeout(r, 1000));
	}
}
const stopServer = () => {
	if (server && server.exitCode === null) server.kill("SIGTERM");
};
process.on("exit", stopServer);
process.on("SIGINT", () => process.exit(130));

const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "–");

async function main() {
	if (args.includes("--start-server")) await startServer();
	else if (!(await health()))
		throw new Error(`no service at ${URL} (use --start-server)`);
	fs.mkdirSync(path.join(OUT, "cues"), { recursive: true });
	const report: Record<string, unknown>[] = [];
	for (const photo of photos) {
		const s = await loadScene(photo);
		let mode = poseMode;
		let cam = await baselineCam(photo, mode);
		if (mode === "app" && !(await appSolve(photo)).accepted) {
			console.log(`${photo}: app solve not accepted → starting from GT pose`);
			mode = "gt";
			cam = gtCam(photo);
		}
		const buf = fs.readFileSync(
			path.join(ROOT, "public", "photos", `${photo}.jpg`),
		);
		const t0 = Date.now();
		let r: RematchResult;
		try {
			r = await rematch({
				photo: new Blob([buf], { type: "image/jpeg" }),
				photoId: photo,
				cam,
				lat: s.lat,
				lon: s.lon,
				frameOrigin: { lat: s.lat, lon: s.lon, alt: s.eyeAlt },
				tiles,
				iterations,
				mask: false,
				url: URL,
			});
		} catch (e) {
			console.log(`${photo}: FAILED ${(e as Error).message}`);
			report.push({ photo, error: (e as Error).message });
			continue;
		}
		const wallMs = Date.now() - t0;
		console.log(
			`\n${photo} (start pose ${mode}; ${wallMs} ms wall; ${JSON.stringify(r.timingMs)})`,
		);
		if (r.notes?.length) console.log(`  notes: ${r.notes.join("; ")}`);
		console.log(
			"  iter  views  matches  inliers  lower  quads  bands  medPx  change   ms",
		);
		for (const [i, it] of r.iterations.entries())
			console.log(
				`  ${String(i + 1).padStart(4)}  ${String(it.views).padStart(5)}  ${String(it.nMatches).padStart(7)}  ${String(it.n).padStart(7)}  ${String(it.nLower).padStart(5)}  ${String(it.coverage.quadrants).padStart(5)}  ${String(it.coverage.bands).padStart(5)}  ${f1(it.medPx).padStart(5)}  ${f1(it.changePx ?? Number.NaN).padStart(6)}  ${it.ms}`,
			);
		for (const [i, it] of r.iterations.entries())
			console.log(
				`  iter ${i + 1} per view: ${JSON.stringify(it.perView ?? {})}`,
			);
		// acceptance 1: iteration 2 vs 1
		let acc1: Record<string, unknown> = { pending: "only one iteration" };
		if (r.iterations.length >= 2) {
			const [a, b] = r.iterations;
			const lowerGain = (b.nLower ?? 0) / Math.max(1, a.nLower ?? 0) - 1;
			const quadGain = b.coverage.quadrants - a.coverage.quadrants;
			acc1 = {
				lowerGain,
				quadGain,
				iter1Quadrants: a.coverage.quadrants,
				passLower: lowerGain >= 0.25,
				passQuad: quadGain >= 2,
			};
			console.log(
				`  iter2 vs iter1: lower-half inliers ${a.nLower} → ${b.nLower} (${(lowerGain * 100).toFixed(0)}%, need ≥25%), quadrants ${a.coverage.quadrants} → ${b.coverage.quadrants} (need +2)`,
			);
		}
		// parity: TS projectX of the returned cam vs the server's residuals
		const rc = r.cam as NonNullable<RematchResult["cam"]>;
		const { W, H } = basis1600(rc.aspect);
		let parity = 0;
		for (const p of r.inliers) {
			const q = projectX(rc, p.world);
			if (!q) continue;
			const res = Math.hypot((q.u - p.u) * W, (q.v - p.v) * H);
			parity = Math.max(parity, Math.abs(res - p.resPx));
		}
		console.log(
			`  parity |resPx(TS projectX) − resPx(server)| max ${parity.toExponential(2)} px`,
		);
		// mask check: reprojection error (px @1600) and signed vertical error of the lifted points with
		// the DTM lift vs the semantic lift (liftM), under two references: the GT camera (pin-fitted, GT eye)
		// and the loop's own refined camera (rotation fitted to all inliers, start eye). Points < 5 km.
		const refs = { gt: gtCam(photo), refined: rc } as const;
		const near = r.inliers.filter((p) => (p.depthM ?? 0) < 5000);
		const mask: Record<string, unknown> = {};
		for (const [rn, ref] of Object.entries(refs)) {
			const d = (w: Vec3, u: number, v: number): [number, number] => {
				const q = projectX(ref, w);
				return q
					? [Math.hypot((q.u - u) * W, (q.v - v) * H), (q.v - v) * H]
					: [Number.NaN, Number.NaN];
			};
			for (const cls of ["building", "forest", "all<5km"]) {
				const sel =
					cls === "all<5km" ? near : near.filter((p) => p.cls === cls);
				const dtm = sel.map((p) => d(p.world, p.u, p.v));
				const lifted = sel.map((p) =>
					d([p.world[0], p.world[1], p.world[2] + (p.liftM ?? 0)], p.u, p.v),
				);
				const drop = sel.filter((p) => !p.cls).map((p) => d(p.world, p.u, p.v));
				const m = {
					n: sel.length,
					medDtm: median(dtm.map((x) => x[0])),
					medLift: median(lifted.map((x) => x[0])),
					dyDtm: median(dtm.map((x) => x[1])),
					dyLift: median(lifted.map((x) => x[1])),
					nDrop: drop.length,
					medDrop: median(drop.map((x) => x[0])),
				};
				mask[`${rn}:${cls}`] = m;
				console.log(
					`  mask @${rn.padEnd(7)} ${cls.padEnd(8)} n=${String(m.n).padStart(4)}  median DTM ${f1(m.medDtm)} → lift ${f1(m.medLift)} px (signed dy ${f1(m.dyDtm)} → ${f1(m.dyLift)})` +
						(cls === "all<5km"
							? `; drop classed → n=${m.nDrop} median ${f1(m.medDrop)}`
							: ""),
				);
			}
		}
		fs.mkdirSync(path.join(OUT, "inliers"), { recursive: true });
		fs.writeFileSync(
			path.join(OUT, "inliers", `${photo}.json`),
			JSON.stringify({ photo, startPose: mode, start: cam, ...r }),
		);
		const cues = inliersToCues(r);
		fs.writeFileSync(
			path.join(OUT, "cues", `${photo}.json`),
			JSON.stringify({
				photo,
				frame: "concord GT scene frame (scripts/concord/lib.ts)",
				startPose: mode,
				cam: r.cam,
				cues,
			}),
		);
		report.push({
			photo,
			startPose: mode,
			wallMs,
			timingMs: r.timingMs,
			iterations: r.iterations,
			acc1,
			parityPx: parity,
			mask,
			nInliers: r.inliers.length,
			notes: r.notes,
		});
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const file = path.join(OUT, `eval-${stamp}.json`);
	fs.writeFileSync(
		file,
		JSON.stringify({ photos, poseMode, tiles, iterations, report }, null, 1),
	);
	console.log(`\nwrote ${path.relative(ROOT, file)}`);
}

main()
	.catch((e) => {
		console.error(e);
		process.exitCode = 1;
	})
	.finally(stopServer);
