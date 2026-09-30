// The terrain material (materials.ts makeTerrainMaterial) ported to TSL for three's WebGPURenderer.
// Spike scope: the classic hillshade look (uStyle 0 with no LOOK_* define) plus the geometry output
// (uStyle 3: xyz = ENU metres, w = range) as an MRT attachment, so one pass fills both targets.
//
// The shared uniform record (materials.ts makeSharedUniforms) stays the single source of truth: every
// TSL uniform reads its `.value` once per render (onRenderUpdate), and the ramp arrays are bound by
// reference (uniformArray re-packs the same JS arrays each render). style/three-apply.ts and writeRamp
// therefore restyle both renderers without changes.
import type * as THREE from "three";
import {
	attribute,
	cameraPosition,
	clamp,
	dot,
	exp,
	float,
	length,
	max,
	mix,
	modelWorldMatrix,
	mrt,
	normalize,
	normalLocal,
	output,
	positionWorld,
	pow,
	select,
	smoothstep,
	uniform,
	uniformArray,
	varying,
	vec3,
	vec4,
} from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { RAMP_MAX } from "#/lib/materials";

// TSL's node types are generic over the WGSL type; the spike keeps them loose (as the three docs do)
// biome-ignore lint/suspicious/noExplicitAny: TSL node graphs
type N = any;
type Shared = Record<string, THREE.IUniform>;

/** A TSL uniform that follows `shared[key].value` (re-read once per render). */
function bridge(shared: Shared, key: string): N {
	const u = shared[key];
	if (!u) throw new Error(`terrain-tsl: no shared uniform ${key}`);
	return uniform(u.value).onRenderUpdate(() => u.value);
}

/** materials.ts rampEval over one ramp's uniform arrays (C, T, D, E, N), as a TSL expression of t. */
function rampEval(shared: Shared, prefix: string): (t: N) => N {
	const C: N = uniformArray(shared[`${prefix}C`].value as unknown[], "vec3");
	const T: N = uniformArray(shared[`${prefix}T`].value as unknown[], "float");
	const D: N = uniformArray(shared[`${prefix}D`].value as unknown[], "float");
	const E: N = uniformArray(shared[`${prefix}E`].value as unknown[], "float");
	const n = bridge(shared, `${prefix}N`);
	return (t: N) => {
		// GLSL: the first i in 1..n-1 with t < T[i] (or the last stop) wins. Unrolled descending, the
		// smallest qualifying i is applied last, so the result is the same without a loop / break.
		let c: N = C.element(0);
		for (let i = RAMP_MAX - 1; i >= 1; i--) {
			const lo = T.element(i - 1);
			const hi = T.element(i);
			const f = select(
				E.element(i).greaterThan(0.5),
				smoothstep(lo, hi, t),
				clamp(t.sub(lo).div(D.element(i)), 0, 1),
			);
			const hit = float(i)
				.lessThan(n)
				.and(t.lessThan(hi).or(float(i).equal(n.sub(1))));
			c = select(hit, mix(C.element(i - 1), C.element(i), f), c);
		}
		return c;
	};
}

const toLinear = (c: N): N => pow(c, vec3(2.2));

export type TerrainNodes = {
	/** Linear colour of the classic hillshade (the fragment shader's gl_FragColor before colorspace_fragment). */
	color: N;
	/** vec4(ENU xyz, range from the camera): the uStyle 3 geometry output. */
	geometry: N;
};

/** The node graph shared by every tile material (one per Terrain, like the shared uniforms). */
export function terrainNodes(shared: Shared): TerrainNodes {
	const sunDir = bridge(shared, "uSunDir");
	const elevRange = bridge(shared, "uElevRange");
	const haze = bridge(shared, "uHaze");
	const hazeColor = bridge(shared, "uHazeColor");
	const hazeDensity = bridge(shared, "uHazeDensity");
	const hazeMax = bridge(shared, "uHazeMax");
	const ambient = bridge(shared, "uShadeAmbient");
	const direct = bridge(shared, "uShadeDirect");
	const relief = rampEval(shared, "uReliefRamp");

	// vertex: vNormal = normalize(mat3(modelMatrix) * normal); vElev = elev; vWorld = modelMatrix * position
	const vNormal: N = varying(
		normalize(modelWorldMatrix.mul(vec4(normalLocal, 0)).xyz),
		"vNormal",
	);
	const vElev: N = varying(attribute("elev", "float"), "vElev");
	const world: N = positionWorld;
	const n: N = normalize(vNormal);
	const range: N = length(world.sub(cameraPosition));

	const elevT = clamp(
		vElev.sub(elevRange.x).div(elevRange.y.sub(elevRange.x)),
		0,
		1,
	);
	const albedo = toLinear(relief(elevT));
	const shade = ambient
		.mul(float(0.5).add(n.z.mul(0.5)))
		.add(direct.mul(max(dot(n, sunDir), 0)));
	const base = albedo.mul(shade);
	// uHazeColor is already linear and gets toLinear again: the classic double linearisation (materials.ts)
	const f = float(1).sub(exp(range.negate().mul(hazeDensity).mul(haze)));
	const color = mix(base, toLinear(hazeColor), clamp(f, 0, hazeMax));
	return { color, geometry: vec4(world, range) };
}

/**
 * One tile's material. `outputNode` is the linear colour (the renderer encodes to the canvas's sRGB);
 * `mrtNode` adds the geometry attachment when the render target has a texture named "geo".
 */
export function makeTerrainNodeMaterial(nodes: TerrainNodes) {
	const m = new MeshBasicNodeMaterial();
	const color = vec4(nodes.color, 1);
	m.outputNode = color;
	// MRTNode blends only "output" (material blending); any other attachment gets NoBlending, which
	// rgba32float needs (it is not blendable without the optional float32-blendable feature). "output"
	// is given explicitly: with a material-only MRT, NodeMaterial does not route outputNode into the
	// `output` property.
	m.mrtNode = mrt({ output: color, geo: nodes.geometry });
	// terrain.ts reads tile.mesh.material.uniforms.map (imagery, dispose): a stub keeps it working
	Object.assign(m, {
		uniforms: { map: { value: null }, hasMap: { value: 0 } },
	});
	return m;
}

/**
 * The renderer-level MRT for the colour + geometry pass (`renderer.setMRT(...)`). three clears a
 * non-first attachment to (0, 0, 0, 1) unless the RENDERER's MRT names a clear colour, so the material
 * MRT alone would leave w = 1 ("hit at 1 m") on every sky pixel. The geometry node uses only
 * positionWorld / cameraPosition, so it is valid for any material in the scene.
 */
export function geometryMRT(nodes: TerrainNodes) {
	return mrt({ output, geo: nodes.geometry }).setClearColor("geo", 0x000000, 0);
}
