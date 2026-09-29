// Checks for Step Inside P3 (DEM-conditioned generation). Run: npx tsx src/lib/nearfield/generate/generate.check.ts
// Exits 1 on any failure. The load-bearing ones: generated splats NEVER reach a measurement export
// (provenance.filterForExport, export/splat.ts exportableCloud / buildSplatExport in both formats) and the
// hover readout (./readout.ts) never returns one, even when it is the nearest thing on the ray.
// Also: only hole pixels are lifted, DEM-backed generated splats sit on the DEM, the monocular alignment
// recovers a known scale, the trajectory respects the confidence radius, and the GEN3C / LingBot packages
// have the documented shapes and consistent cameras.
import { type Pose, poseBasis, projectPoint } from "../../camera";
import {
	buildSplatExport,
	encodeGaussianPly,
	exportableCloud,
} from "../../export/splat";
import { intrinsicsFromPose } from "../geom";
import { filterForExport } from "../provenance";
import { decodeGaussianPly, decodeSplatV1 } from "../splat-io";
import {
	type GaussianCloud,
	type NearFieldDepth,
	type NearFieldScene,
	PROVENANCE_CODE,
} from "../types";
import {
	alignMono,
	holeMask,
	holeStats,
	liftGenerated,
	mergeClouds,
	type RgbdView,
	rayDir,
} from "./holes";
import { readoutHit } from "./readout";
import {
	buildGen3cRequest,
	buildLingbotRequest,
	encodeNpy,
	gen3cNpz,
	interpolatePath,
	invRigid,
	w2cOpenCV,
} from "./remote";
import { makeTrajectory } from "./trajectory";

let failed = 0;
function ok(cond: boolean, msg: string) {
	console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
	if (!cond) failed++;
}
const GEN = PROVENANCE_CODE.generated;

// ---- a synthetic RGB-D cache view: flat DEM plane z = 0, camera 2 m above it looking north, 10° down ----
const pose: Pose = { yaw: 0, pitch: -10, roll: 0, vfov: 50 };
const eye: [number, number, number] = [0, 0, 2];
const W = 96;
const H = 72;
const aspect = W / H;
function planeView(): RgbdView {
	const n = W * H;
	const K = intrinsicsFromPose(pose, aspect);
	const B = poseBasis(pose);
	const world = new Float32Array(3 * n).fill(Number.NaN);
	const range = new Float32Array(n);
	const observed = new Uint8Array(n);
	const rgba = new Uint8ClampedArray(4 * n);
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const k = j * W + i;
			const d = rayDir(pose, K, (i + 0.5) / W, (j + 0.5) / H, B);
			rgba[4 * k + 3] = 255;
			if (d[2] < -1e-3) {
				const t = -eye[2] / d[2];
				if (t < 5000) {
					range[k] = t;
					world.set([eye[0] + d[0] * t, eye[1] + d[1] * t, 0], 3 * k);
				}
			}
			// observed everywhere except a block (disocclusion) and the right strip (out of frustum; incl. sky)
			const blk = i >= 30 && i < 50 && j >= 45 && j < 60;
			const strip = i >= W - 10;
			if (!blk && !strip) {
				observed[k] = 1;
				rgba.set([100, 120, 80], 4 * k);
			}
		}
	return {
		width: W,
		height: H,
		camera: { name: "t", pose, eye, offset: [0, 0, 0] },
		aspect,
		rgba,
		world,
		range,
		observed,
		sky: new Uint8Array(n),
	};
}

const view = planeView();
const hole = holeMask(view, 0);
const st = holeStats(view, hole);
{
	let nh = 0;
	for (const x of hole) nh += x;
	ok(nh === 20 * 15 + 10 * H, `hole mask = unobserved pixels (${nh})`);
	ok(
		st.demBacked > 0.5 && st.noGeo > 0,
		`hole stats: demBacked ${st.demBacked.toFixed(2)}, noGeo ${st.noGeo.toFixed(2)}`,
	);
	const d1 = holeMask(view, 1);
	let n1 = 0;
	for (const x of d1) n1 += x;
	ok(n1 > nh, "dilation grows the hole");
}

// filled image: magenta-ish in the holes, untouched elsewhere
const filled = view.rgba.slice();
for (let k = 0; k < W * H; k++) if (hole[k]) filled.set([200, 60, 180], 4 * k);
const lifted = liftGenerated(view, filled, hole, { stride: 2 });
{
	const g = lifted.cloud;
	ok(
		g.count > 0 && g.frame === "enu",
		`lifted ${g.count} generated Gaussians (ENU)`,
	);
	ok(
		g.provenance.every((p) => p === GEN),
		"every lifted Gaussian is provenance generated",
	);
	// each lies on the plane (just in front: toward-eye bias) and projects into a hole pixel
	let onPlane = 0;
	let inHole = 0;
	for (let i = 0; i < g.count; i++) {
		const p = [
			g.positions[3 * i],
			g.positions[3 * i + 1],
			g.positions[3 * i + 2],
		];
		if (p[2] >= -1e-3 && p[2] < 0.1) onPlane++;
		const uv = projectPoint(pose, aspect, eye, p);
		if (uv) {
			const x = Math.min(W - 1, Math.floor(uv.u * W));
			const y = Math.min(H - 1, Math.floor(uv.v * H));
			// block centres sit on (odd) pixel centres; allow the 1-px block neighbourhood
			let any = false;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					const xx = x + dx;
					const yy = y + dy;
					if (xx >= 0 && yy >= 0 && xx < W && yy < H && hole[yy * W + xx])
						any = true;
				}
			if (any) inHole++;
		}
	}
	ok(
		onPlane === g.count,
		`DEM-backed generated splats sit on the DEM plane (${onPlane}/${g.count})`,
	);
	ok(
		inHole === g.count,
		`every generated splat reprojects into a hole (${inHole}/${g.count})`,
	);
	ok(
		lifted.stats.mono === 0 && lifted.stats.skipped > 0,
		`no-DEM holes are skipped without mono (${lifted.stats.skipped})`,
	);
	ok(
		g.colors[0] === 200 && g.colors[1] === 60 && g.colors[2] === 180,
		"colours come from the filled image",
	);
}

// ---- monocular alignment: mono = DEM / 3 (a compressed model) → scale 3 ----
{
	const mono: NearFieldDepth = {
		width: W,
		height: H,
		depth: new Float32Array(W * H),
		valid: new Uint8Array(W * H),
		model: "synthetic",
		seconds: 0,
	};
	const K = intrinsicsFromPose(pose, aspect);
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const k = j * W + i;
			const u = (i + 0.5) / W;
			const v = (j + 0.5) / H;
			const x = (u - K.cx) / K.fx;
			const y = (v - K.cy) / K.fy;
			const rf = Math.sqrt(1 + x * x + y * y);
			// the no-DEM strip gets a plausible depth too (20 m / 3)
			const r = view.range[k] > 0 ? view.range[k] : 20;
			mono.depth[k] = r / 3 / rf;
			mono.valid[k] = 1;
		}
	const needs = new Uint8Array(W * H);
	for (let k = 0; k < W * H; k++)
		needs[k] = hole[k] && !(view.range[k] > 0) ? 1 : 0;
	const a = alignMono(view, mono, needs);
	ok(
		Math.abs(a.scale - 3) < 0.03 && a.residualLog < 0.01,
		`alignMono recovers scale 3 (${a.scale.toFixed(3)}, ${a.mode}, n=${a.n})`,
	);
	const withMono = liftGenerated(view, filled, hole, {
		stride: 2,
		mono: { depth: mono, align: a },
	});
	ok(
		withMono.stats.mono > 0 &&
			withMono.cloud.provenance.every((p) => p === GEN),
		`mono-lifted holes are generated too (${withMono.stats.mono})`,
	);
}

// ---- the load-bearing checks: exports and readout never carry generated content ----
function observedCloud(n: number): GaussianCloud {
	const c: GaussianCloud = {
		count: n,
		frame: "enu",
		positions: new Float32Array(3 * n),
		scales: new Float32Array(3 * n).fill(0.2),
		rotations: new Float32Array(4 * n),
		colors: new Uint8Array(4 * n).fill(200),
		provenance: new Uint8Array(n),
	};
	for (let i = 0; i < n; i++) {
		c.positions.set([0, 30 + i, 1.5], 3 * i); // a column of splats straight ahead (north)
		c.rotations[4 * i] = 1;
		c.provenance[i] =
			i % 3 === 0 ? PROVENANCE_CODE.reconstructed : PROVENANCE_CODE.observed;
	}
	return c;
}
const obs = observedCloud(40);
const merged = mergeClouds(obs, lifted.cloud);
{
	ok(
		merged.count === obs.count + lifted.cloud.count,
		"merge keeps every splat",
	);
	const f = filterForExport(merged);
	ok(
		f.count === obs.count,
		`filterForExport keeps exactly the observed/reconstructed splats (${f.count})`,
	);
	ok(
		!f.provenance.includes(GEN),
		"filterForExport output has no generated splat",
	);
	const scene: NearFieldScene = {
		photoId: "synthetic",
		anchor: {
			scale: 1,
			shift: 0,
			residualLog: 0.1,
			inlierFrac: 0.8,
			n: 5000,
			quality: 0.7,
			maxRange: 3000,
		},
		split: {
			width: 1,
			height: 1,
			cls: new Uint8Array(1),
			counts: [0, 0, 0, 0, 0],
		},
		splats: merged,
		confidenceRadius: 30,
	};
	const ex = exportableCloud(scene);
	ok(
		ex.stats.droppedGenerated === lifted.cloud.count &&
			ex.cloud.count === obs.count,
		`exportableCloud drops all ${lifted.cloud.count} generated`,
	);
	const origin = { lat: 46.99, lon: 8.66, h: 1300 };
	const v1 = buildSplatExport(scene, "splat-v1", { origin });
	const d1 = decodeSplatV1(v1.bytes);
	ok(
		d1.count === obs.count && !d1.provenance.includes(GEN),
		`.splat-v1 export: ${d1.count} splats, 0 generated`,
	);
	const ply = buildSplatExport(scene, "splat-ply", { origin });
	const dp = decodeGaussianPly(ply.bytes, { frame: "enu" });
	ok(
		dp.count === obs.count,
		`.ply export: ${dp.count} splats (generated left out)`,
	);
	ok(
		ply.notes.some((s) => s.includes("generated")),
		`export notes say generated splats were left out ("${ply.notes.join("; ")}")`,
	);
	// a raw encode of the merged cloud WOULD carry them: the filter is what protects the export
	const raw = decodeGaussianPly(encodeGaussianPly(merged), { frame: "enu" });
	ok(
		raw.count === merged.count,
		"(control) an unfiltered encode would have carried the generated splats",
	);

	// readout: put a generated splat right in front of the observed column on the ray from the origin
	const trap: GaussianCloud = mergeClouds(merged, {
		count: 1,
		frame: "enu",
		positions: Float32Array.from([0, 10, 1.5]),
		scales: Float32Array.from([1, 1, 1]),
		rotations: Float32Array.from([1, 0, 0, 0]),
		colors: Uint8Array.from([255, 0, 255, 255]),
		provenance: Uint8Array.from([GEN]),
	});
	const hit = readoutHit(trap, [0, 0, 1.5], [0, 1, 0]);
	ok(
		!!hit && hit.provenance !== GEN && Math.abs(hit.t - 30) < 1e-4,
		`readout skips the generated splat and measures the observed one at ${hit?.t.toFixed(2)} m`,
	);
	ok(
		hit?.skippedGenerated === 1,
		"readout reports the generated splat it passed through",
	);
	const onlyGen = readoutHit(
		lifted.cloud,
		eye,
		rayDir(pose, intrinsicsFromPose(pose, aspect), 0.42, 0.72),
	);
	ok(
		onlyGen === null,
		"readout over generated-only content returns null (falls back to the DEM)",
	);
	// every generated splat in the synthetic view: none is ever returned
	let leaked = 0;
	const K = intrinsicsFromPose(pose, aspect);
	for (let j = 0; j < H; j += 3)
		for (let i = 0; i < W; i += 3) {
			const h = readoutHit(
				merged,
				eye,
				rayDir(pose, K, (i + 0.5) / W, (j + 0.5) / H),
			);
			if (h && h.provenance === GEN) leaked++;
		}
	ok(
		leaked === 0,
		"no readout ray over the merged scene returns a generated splat",
	);
}

// ---- trajectory ----
{
	const cams = makeTrajectory(
		pose,
		{ x: 0, y: 0, z: 2 },
		{ step: 50, radius: 20, pivotDist: 40 },
	);
	ok(cams.length === 3, "default trajectory: right, left, forward");
	ok(
		cams.every((c) => Math.hypot(...c.offset) <= 20 + 1e-9),
		"every camera within the confidence radius",
	);
	const r = cams[0];
	const F = poseBasis(r.pose).forward;
	const piv = [
		0,
		40 * Math.cos((-10 * Math.PI) / 180),
		2 + 40 * Math.sin((-10 * Math.PI) / 180),
	];
	const d = [piv[0] - r.eye[0], piv[1] - r.eye[1], piv[2] - r.eye[2]];
	const l = Math.hypot(d[0], d[1], d[2]);
	ok(
		Math.abs(F[0] - d[0] / l) +
			Math.abs(F[1] - d[1] / l) +
			Math.abs(F[2] - d[2] / l) <
			1e-6,
		"pivot aim looks at the pivot",
	);
	const rb = poseBasis(pose).right;
	ok(
		r.offset[0] * rb[0] + r.offset[1] * rb[1] > 0,
		"'right' moves to the photo's right",
	);
}

// ---- remote packages ----
{
	const w2c = w2cOpenCV(pose, eye);
	const c2w = invRigid(w2c);
	ok(
		Math.abs(c2w[3] - eye[0]) +
			Math.abs(c2w[7] - eye[1]) +
			Math.abs(c2w[11] - eye[2]) <
			1e-9,
		"c2w translation = camera centre",
	);
	// forward maps to +z camera
	const F = poseBasis(pose).forward;
	const p = [eye[0] + F[0] * 10, eye[1] + F[1] * 10, eye[2] + F[2] * 10];
	const zc = w2c[8] * p[0] + w2c[9] * p[1] + w2c[10] * p[2] + w2c[11];
	const xc = w2c[0] * p[0] + w2c[1] * p[1] + w2c[2] * p[2] + w2c[3];
	ok(
		Math.abs(zc - 10) < 1e-9 && Math.abs(xc) < 1e-9,
		"w2c: a point 10 m ahead is at camera (0, 0, 10)",
	);
	const cams = makeTrajectory(
		pose,
		{ x: eye[0], y: eye[1], z: eye[2] },
		{ step: 5 },
	);
	const path = interpolatePath({ pose, eye }, cams, 30);
	ok(
		path.length === 30 && path[0].eye[0] === eye[0],
		"interpolated path starts at the photo camera",
	);
	const zd = new Float32Array(W * H);
	for (let k = 0; k < W * H; k++)
		zd[k] = view.range[k] > 0 ? view.range[k] * 0.9 : 0;
	const g = buildGen3cRequest(
		[{ width: W, height: H, rgba: view.rgba, zDepth: zd, pose, eye }],
		path,
		eye,
	);
	ok(
		g.npz.images_key_frames.shape.join() === "1,3,704,1280" &&
			g.npz.w2cs_all.shape.join() === "121,4,4",
		`GEN3C npz shapes (${g.npz.w2cs_all.shape})`,
	);
	ok(
		g.argv.includes("--npz_path") &&
			g.argv.includes("121") &&
			(Number(g.argv[g.argv.indexOf("--num_video_frames") + 1]) - 1) % 120 ===
				0,
		"GEN3C argv: npz path + 120N+1 frames (upstream assert)",
	);
	ok(
		g.argv[g.argv.indexOf("--prompt") + 1]?.length > 0 &&
			g.argv.includes("--disable_prompt_upsampler"),
		"GEN3C argv always carries a prompt (upstream skips prompt-less items)",
	);
	const im = g.npz.images_key_frames.data;
	let lo = 0;
	let hi = 0;
	for (const x of im) {
		if (x < -1 - 1e-6) lo++;
		if (x > 1 + 1e-6) hi++;
	}
	ok(lo === 0 && hi === 0, "GEN3C images in [-1, 1]");
	const npz = gen3cNpz(g);
	ok(
		npz[0] === 0x50 && npz[1] === 0x4b && npz.length > 704 * 1280 * 4 * 5,
		`npz is a zip (${(npz.length / 1e6).toFixed(1)} MB)`,
	);
	const npy = encodeNpy({ shape: [2, 3], data: new Float32Array(6) });
	ok(
		(npy[8] + 10) % 64 === 0 && npy.length === 10 + npy[8] + 24,
		".npy header padded to 64 bytes",
	);
	const lb = buildLingbotRequest(path, eye);
	ok(
		lb.files["poses.npy"].shape.join() === "33,4,4" &&
			lb.files["intrinsics.npy"].shape.join() === "33,4",
		`LingBot 4n+1 frames (${lb.files["poses.npy"].shape[0]})`,
	);
	const P0 = lb.files["poses.npy"].data;
	ok(
		Math.abs(P0[3]) + Math.abs(P0[7]) + Math.abs(P0[11]) < 1e-6,
		"LingBot frame 0 c2w at the eye-centred origin",
	);
}

console.log(failed ? `\n${failed} FAILED` : "\nall generate checks passed");
process.exit(failed ? 1 : 0);
