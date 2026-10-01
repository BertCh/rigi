// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CPU check for layers/drape.ts (no GPU):
//   1. the terrain colour program with the drape plugin (plain and DRAPE_HARMONIZE) assembles the
//      way luma's Model does (a fresh WGSLShaderAssembler, like pass.ts RIGI_WGSL_ASSEMBLER), and
//      its binding layout (the assembler's own shaderLayout) has the drape's uniforms and textures;
//   2. the occlusion test (drapeVisibilityCpu = the shader's drape_visibility, + drapeSlack) on a
//      ray-cast range map of a flat valley floor seen at grazing incidence with a wall across it:
//      the classic single-texel test rejects open ground ("drape acne"), the soft 2×2 vote +
//      slope bias must not, and neither may leak onto ground well behind the wall. (Within
//      ~1.5·r·Δθ/0.012 behind an occluder, ≈ 240 m here at r ≈ 1.9 km, the bias does let the drape
//      through: the same trade multi-drape-layer.ts makes, hence the behind samples start 400 m back.)
//   npx tsx src/lib/deck-webgpu/layers/drape.check.ts
import { WGSLShaderAssembler } from "@luma.gl/shadertools";
import type { Vec3 } from "#/lib/ontology/core/geometry";
import { cameraUniforms, photoCamera, projectToPixel } from "../camera";
import {
	TILE_VERTEX_WGSL,
	terrainDefines,
	terrainModules,
	terrainSource,
} from "../terrain";
import { DrapePart, drapeSlack, drapeVisibilityCpu } from "./drape";

// ---- 1. assembly + layout ----
const asm = new WGSLShaderAssembler();
const fakeDevice = {
	createTexture: () => ({ writeData() {}, destroy() {} }),
} as never;
const layouts: Record<string, string[]> = {};
for (const harmonize of [false, true]) {
	const d = new DrapePart(fakeDevice);
	d.setSettings({
		harmonize: harmonize
			? {
					pm: [],
					ps: [],
					lm: [],
					ls: [],
					amount: 1,
					chroma: 0.6,
				}
			: null,
	});
	const part = d.part();
	const r = asm.assembleWGSLShader({
		platformInfo: {
			type: "webgpu",
			shaderLanguage: "wgsl",
			shaderLanguageVersion: 100,
			gpu: "apple",
			features: new Set(),
		},
		source: terrainSource(TILE_VERTEX_WGSL, null, [part]),
		modules: terrainModules([part]),
		defines: terrainDefines("color", [part]),
	});
	const names = (r.shaderLayout?.bindings ?? []).map((b) => b.name);
	layouts[part.key] = names;
	const table = () =>
		r.bindingTable
			.map(
				(b) =>
					`${b.group}:${b.binding} ${b.name} ${b.kind} ${b.moduleName ?? b.owner}`,
			)
			.join("\n  ");
	const want = [
		"camera",
		"fog",
		"terrain",
		"photoCam",
		"drape",
		"drapeGeo",
		"drapePhoto",
		"drapePhotoSampler",
		"drapeMask",
		"drapeMaskSampler",
		...(harmonize ? ["drapeHrm"] : []),
	];
	for (const n of want)
		if (!names.includes(n))
			throw new Error(
				`${part.key}: binding ${n} missing; bindingTable:\n  ${table()}`,
			);
	if (!harmonize && names.includes("drapeHrm"))
		throw new Error(
			`drapeHrm bound without DRAPE_HARMONIZE; bindingTable:\n  ${table()}`,
		);
	if (!r.source.includes("c = drape_apply(c, s);"))
		throw new Error("plugin call not spliced");
}

// ---- 2. occlusion on a grazing valley floor ----
const W = 1024;
const H = 683;
const pose = { yaw: 0, pitch: -0.5, roll: 0, vfov: 40 };
const eye: Vec3 = [0, 0, 10];
const u = cameraUniforms(photoCamera({ pose, eye, width: W, height: H }));
const WALL_Y = 1500;
const WALL_H = 40;
/** First hit of the ray: ground z = 0, or the wall y = WALL_Y (0 < z < WALL_H). */
function cast(dir: Vec3): number {
	let best = 0;
	if (dir[2] < 0) best = -eye[2] / dir[2];
	if (dir[1] > 0) {
		const t = (WALL_Y - eye[1]) / dir[1];
		const z = eye[2] + t * dir[2];
		if (z > 0 && z < WALL_H && (!best || t < best)) best = t;
	}
	return best; // |dir| = 1 → range in metres; 0 = sky
}
const range = new Float32Array(W * H);
for (let y = 0; y < H; y++)
	for (let x = 0; x < W; x++) {
		const nx = ((x + 0.5) / W) * 2 - 1;
		const ny = 1 - ((y + 0.5) / H) * 2;
		const d: Vec3 = [0, 0, 0];
		for (let k = 0; k < 3; k++)
			d[k] =
				u.forward[k] + nx * u.tanHalfX * u.right[k] + ny * u.tanHalfY * u.up[k];
		const l = Math.hypot(...d);
		range[y * W + x] = cast([d[0] / l, d[1] / l, d[2] / l]);
	}

let seed = 11;
const rnd = () => {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed / 0x7fffffff;
};
const stats = {
	open: { n: 0, classicRejected: 0, voteRejected: 0, voteSoft: 0 },
	behind: { n: 0, classicLeak: 0, voteLeak: 0 },
};
const n: Vec3 = [0, 0, 1];
for (let k = 0; k < 40000; k++) {
	// ground points in front of the wall (open) and well behind it (occluded)
	const behind = k % 2 === 1;
	const p: Vec3 = [
		(rnd() - 0.5) * 1200,
		behind ? WALL_Y + 400 + rnd() * 1000 : 150 + rnd() * (WALL_Y - 160),
		0,
	];
	const px = projectToPixel(u, p);
	if (!px) continue;
	const uv: [number, number] = [px.x / W, px.y / H];
	if (uv[0] <= 0 || uv[0] >= 1 || uv[1] <= 0 || uv[1] >= 1) continue;
	const dx = p[0] - eye[0];
	const dy = p[1] - eye[1];
	const dz = p[2] - eye[2];
	const r = Math.hypot(dx, dy, dz);
	const sinInc = -(dx * n[0] + dy * n[1] + dz * n[2]) / r;
	const classic = drapeVisibilityCpu(range, W, H, uv, r, 0, false);
	const vis = drapeVisibilityCpu(
		range,
		W,
		H,
		uv,
		r,
		drapeSlack(r, sinInc, u.tanHalfY, H),
		true,
	);
	const seen = vis <= 0 ? 0 : vis >= 0.75 ? 1 : smooth(vis / 0.75);
	if (behind) {
		// skip the band within 2 texels below the wall top (its silhouette): only clearly occluded ground
		const wallTop = projectToPixel(u, [p[0], WALL_Y, WALL_H]);
		if (!wallTop || px.y < wallTop.y + 2) continue;
		stats.behind.n++;
		if (classic > 0.5) stats.behind.classicLeak++;
		if (seen > 0.5) stats.behind.voteLeak++;
	} else {
		stats.open.n++;
		if (classic < 0.5) stats.open.classicRejected++;
		if (seen < 0.5) stats.open.voteRejected++;
		if (seen < 0.999) stats.open.voteSoft++;
	}
}
function smooth(t: number) {
	return t * t * (3 - 2 * t);
}

const acneClassic = stats.open.classicRejected / stats.open.n;
const acneVote = stats.open.voteRejected / stats.open.n;
const leakVote = stats.behind.voteLeak / Math.max(1, stats.behind.n);
const ok =
	stats.open.n > 5000 &&
	stats.behind.n > 1000 &&
	acneVote < 0.001 &&
	leakVote < 0.01;
console.log(
	JSON.stringify({
		ok,
		layouts,
		...stats,
		acneClassic,
		acneVote,
		leakVote,
	}),
);
if (!ok) process.exit(1);
