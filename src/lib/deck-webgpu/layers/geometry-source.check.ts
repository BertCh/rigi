// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Browser check for layers/geometry-source.ts. It runs inside /lab/deck-webgpu and needs a real
// WebGPU device and the lab's streamed terrain. From a playwright page on the lab, once
// `__deckWebgpuLab.ready`:
//   const m = await import("/src/lib/deck-webgpu/layers/geometry-source.check.ts");
//   const r = await m.checkGeometrySource();   // r.ok, r.failures
// Checks:
//   1. parity: the off-frame 1024 px source equals the host's own frame geometry pass at the same
//      pose (same cores, camera, target size), texel for texel;
//   2. xyz: stored ENU points re-project onto their own pixel centres (≤ 0.1 px, README rule 10);
//      xyz is NaN exactly where range is Infinity; range is never 0 or NaN;
//   3. row order: top-first (GeometrySource contract), so the top row is sky and skylineRows ≥ 0;
//   4. the 384 px re-rank source is range-only and its skyline agrees with the 1024 one (≤ 2 px);
//   5. supersede: render(A) and render(B) in flight together leave the buffers at B;
//   6. GeometryGenerations: invalidate ×3 → exactly one debounced refresh, ready() after;
//      readback() forces an immediate refresh;
//   7. timing of an off-frame 1024 and 384 render.
import type { Pose } from "#/lib/camera";
import { skylineRows } from "#/lib/deck/geometry-source";
import type { Vec3 } from "#/lib/ontology/core/geometry";
import { cameraUniforms, photoCamera, projectToPixel } from "../camera";
import type { GpuLayerCore } from "../pass";
import { rangeOf, TextureReader } from "../readback";
import type { GeometryTargets } from "../targets";
import { geometrySize } from "../targets";
import {
	GeometryGenerations,
	terrainCoresOf,
	type WebGpuGeometrySource,
	webgpuGeometryFactory,
} from "./geometry-source";

type LabDebug = {
	host: {
		device: import("@luma.gl/core").Device;
		geometry: GeometryTargets;
		cores: GpuLayerCore[];
	};
};

export async function checkGeometrySource() {
	const lab = window.__deckWebgpuLab;
	if (!lab?.ready) throw new Error("lab not ready");
	const dbg = (lab as unknown as { _debug: LabDebug })._debug;
	const { host } = dbg;
	const st = lab.stats() as { pose: Pose; eye: Vec3 };
	const pose = { ...st.pose };
	const eye = st.eye;
	const failures: string[] = [];
	const fail = (s: string) => failures.push(s);

	const cores = terrainCoresOf(host.cores);
	if (!cores.length) fail("terrainCoresOf found no terrain core");
	const factory = webgpuGeometryFactory({
		device: host.device,
		cores: () => cores,
		eye: () => eye,
	});

	// 1. parity with the frame's geometry pass
	await lab.frame();
	const g = host.geometry;
	const reader = new TextureReader(host.device);
	const frameXyzr = await reader.read(g.geometry);
	reader.destroy();
	const aspect = g.width / g.height;
	const size = geometrySize(aspect);
	const q = factory(size.width, size.height) as WebGpuGeometrySource;
	await q.render(pose);
	let parityMax = 0;
	let parityMismatch = 0;
	if (!frameXyzr) fail("frame readback failed");
	else if (g.width !== q.width || g.height !== q.height)
		fail(`size ${q.width}×${q.height} ≠ frame ${g.width}×${g.height}`);
	else {
		const fr = rangeOf(frameXyzr);
		for (let i = 0; i < fr.length; i++) {
			const a = fr[i] > 0 ? fr[i] : Number.POSITIVE_INFINITY;
			const b = q.range[i];
			if (a === b) continue;
			if (!Number.isFinite(a) || !Number.isFinite(b)) parityMismatch++;
			else parityMax = Math.max(parityMax, Math.abs(a - b));
		}
		if (parityMismatch || parityMax > 1e-3)
			fail(
				`parity: ${parityMismatch} sky mismatches, max |Δrange| ${parityMax} m`,
			);
	}

	// 2. xyz re-projection + sky consistency
	const u = cameraUniforms(
		photoCamera({ pose, eye, width: q.width, height: q.height, near: 1 }),
	);
	let n = 0;
	let sky = 0;
	let maxErr = 0;
	let bad = 0;
	const xyz = q.xyz;
	if (!xyz) fail("1024 source has no xyz");
	else
		for (let y = 0; y < q.height; y += 3)
			for (let x = 0; x < q.width; x += 3) {
				const i = y * q.width + x;
				const r = q.range[i];
				const p: Vec3 = [xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]];
				if (r === 0 || Number.isNaN(r)) bad++;
				if (!Number.isFinite(r)) {
					sky++;
					if (!p.every(Number.isNaN)) bad++;
					continue;
				}
				if (p.some(Number.isNaN)) {
					bad++;
					continue;
				}
				const px = projectToPixel(u, p);
				if (!px) continue;
				maxErr = Math.max(
					maxErr,
					Math.hypot(px.x - (x + 0.5), px.y - (y + 0.5)),
				);
				n++;
			}
	if (bad) fail(`${bad} pixels break the range / xyz sky rules`);
	if (!n) fail("no terrain pixels");
	if (maxErr > 0.1) fail(`re-projection max ${maxErr.toFixed(3)} px > 0.1`);

	// 3. row order
	const topSky = q.range.subarray(0, q.width).every((r) => r === Infinity);
	const sk = skylineRows(q);
	const skyCols = sk.filter((r) => r < 0).length;
	if (!topSky) fail("top row is not all sky (rows not top-first?)");
	if (skyCols > q.width / 2)
		fail(`${skyCols}/${q.width} columns have no terrain`);

	// 4. the 384 px re-rank source
	const W = 384;
	const H = Math.round(W / aspect);
	const s = factory(W, H) as WebGpuGeometrySource;
	await s.render(pose);
	if (s.xyz) fail("384 source carries xyz (should be range-only)");
	const sk384 = skylineRows(s);
	let skyErr = 0;
	for (let x = 0; x < W; x++) {
		const X = Math.min(q.width - 1, Math.floor(((x + 0.5) * q.width) / W));
		if (sk384[x] < 0 || sk[X] < 0) continue;
		const a = ((sk384[x] + 0.5) * q.height) / H;
		skyErr = Math.max(skyErr, Math.abs(a - (sk[X] + 0.5)) * (H / q.height));
	}
	if (skyErr > 2) fail(`384 skyline off by ${skyErr.toFixed(2)} px`);

	// 5. supersede
	const poseB = { ...pose, yaw: pose.yaw + 3 };
	await Promise.all([s.render(pose), s.render(poseB)]);
	if (s.pose?.yaw !== poseB.yaw)
		fail(`supersede: pose ${s.pose?.yaw} ≠ ${poseB.yaw}`);

	// 6. generations
	let current = { ...pose };
	let fresh = 0;
	const gens = new GeometryGenerations({
		source: () => s,
		pose: () => current,
		canRender: () => true,
		onFresh: () => fresh++,
	});
	current = { ...pose, yaw: pose.yaw + 1 };
	gens.invalidate();
	current = { ...pose, yaw: pose.yaw + 2 };
	gens.invalidate();
	gens.invalidate();
	const notYet = gens.ready();
	await new Promise((r) => setTimeout(r, 400));
	if (notYet) fail("ready() before the debounced refresh");
	if (!gens.ready()) fail("not ready 400 ms after invalidate");
	if (fresh !== 1) fail(`debounce: ${fresh} refreshes (want 1)`);
	if (s.pose?.yaw !== current.yaw) fail("debounced refresh read a stale pose");
	current = { ...pose };
	gens.invalidate();
	const forced = await gens.readback();
	if (!forced || s.pose?.yaw !== pose.yaw) fail("readback() did not refresh");
	gens.dispose();

	// 7. timing (warm)
	await q.render(pose);
	const t1024 = q.timing;
	await s.render(pose);
	const t384 = s.timing;
	q.dispose();
	s.dispose();

	return {
		ok: failures.length === 0,
		failures,
		size: [size.width, size.height],
		parity: { maxAbsM: parityMax, skyMismatch: parityMismatch },
		reprojection: { samples: n, skySamples: sky, maxErrPx: maxErr },
		topRowSky: topSky,
		skylessColumns: skyCols,
		skyline384MaxErrPx: skyErr,
		generations: { refreshes: fresh, generation: gens.generation },
		timing: { q1024: t1024, s384: t384 },
	};
}
