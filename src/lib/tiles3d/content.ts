// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// A loaded 3D Tiles content (@loaders.gl/3d-tiles: a b3dm / glb / i3dm parsed to a post-processed glTF
// plus `cartesianModelMatrix`, the ECEF ← glTF-local placement) as plain typed arrays: one TileMesh per
// glTF primitive per node. No renderer objects: both deck engines upload TileMeshes themselves
// (deck-layer.ts for WebGL2, deck-webgpu/layers/tiles3d.ts for WebGPU).
//   · the matrix is composed in float64 on the CPU: ENU ← ECEF (frame.ts, geoid inside) × tile placement
//     × glTF node chain, so ECEF magnitudes never reach the GPU
//   · i3dm: the per-instance matrices carry the whole placement (ENU <- ECEF x tile x instance, composed in
//     float64, ENU-sized for float32) and `matrix` is the identity; a node transform is baked into the
//     vertices instead
//   · materials reduce to what we draw: the base colour texture (an image), else a flat colour

import { Matrix4 } from "@math.gl/core";
import type { Vec3 } from "#/lib/ontology/core/geometry";
import type { Tiles3DSource } from "./config";

/** Anything a texture can be uploaded from: a decoded image, or raw RGBA bytes. */
export type TileImage =
	| ImageBitmap
	| HTMLImageElement
	| HTMLCanvasElement
	| { width: number; height: number; data: Uint8Array | Uint8ClampedArray };

export type Sphere = [number, number, number, number];

export type TileMesh = {
	/** Unique per mesh (GPU resource ids, debug). */
	readonly key: string;
	readonly source: Tiles3DSource;
	/** xyz per vertex, tile-local. */
	readonly positions: Float32Array;
	/** uv per vertex (glTF origin top-left), or null. */
	readonly uvs: Float32Array | null;
	/** rgb per vertex, 0..1, or null. */
	readonly colors: Float32Array | null;
	/** Triangle list; null = 0..n-1. */
	readonly indices: Uint16Array | Uint32Array | null;
	/** 16 floats, column-major: ENU ← tile-local. */
	readonly matrix: ArrayLike<number>;
	/** i3dm: 16 floats per instance (column-major, ENU <- local; `matrix` is then the identity), else null. */
	readonly instances: Float32Array | null;
	readonly instanceCount: number;
	readonly image: TileImage | null;
	/** Flat colour for untextured meshes (sRGB-ish 0..1, as the glTF base colour factor). */
	readonly color: Vec3;
	/** The source's log-depth bias (w scale). */
	readonly depthBias: number;
	/** Bounding sphere in the tile-local frame (null: never culled). */
	readonly boundingSphere: Sphere | null;
};

// glTF accessor / node / material shapes, only what is read (loaders.gl post-processed glTF)
type Accessor = {
	value: ArrayLike<number> & { length: number };
	count: number;
	size?: number;
	componentType?: number;
	normalized?: boolean;
	min?: number[];
	max?: number[];
};
type Primitive = {
	mode?: number;
	attributes: Record<string, Accessor | undefined>;
	indices?: Accessor;
	material?: {
		pbrMetallicRoughness?: {
			baseColorFactor?: number[];
			baseColorTexture?: { texture?: { source?: { image?: unknown } } };
		};
	};
};
type GltfNode = {
	matrix?: ArrayLike<number>;
	translation?: number[];
	rotation?: number[];
	scale?: number[];
	mesh?: { primitives?: Primitive[] };
	children?: GltfNode[];
};
export type TileContentLike = {
	gltf?: {
		scene?: number | { nodes?: GltfNode[] };
		scenes?: { nodes?: GltfNode[] }[];
		asset?: { copyright?: string };
	};
	cartesianModelMatrix?: ArrayLike<number>;
	/** i3dm: tile-frame offset of the instance positions (3D Tiles RTC_CENTER). */
	rtcCenter?: ArrayLike<number>;
	/** glTF up axis (3D Tiles default "Y"). */
	gltfUpAxis?: string;
	instances?: { modelMatrix?: ArrayLike<number> }[];
};

const NORMALIZE: Record<number, number> = {
	5120: 127,
	5121: 255,
	5122: 32767,
	5123: 65535,
};

/** An accessor as `size` floats per element (missing lanes = `fill`; integers normalised when flagged). */
export function accessorFloats(
	a: Accessor,
	size: number,
	fill = 1,
): Float32Array {
	const n = a.count;
	const comps =
		a.size ?? Math.max(1, Math.round(a.value.length / Math.max(1, n)));
	const src = a.value;
	const div = a.normalized ? (NORMALIZE[a.componentType ?? 0] ?? 1) : 1;
	if (src instanceof Float32Array && comps === size) return src;
	const out = new Float32Array(n * size);
	for (let i = 0; i < n; i++)
		for (let k = 0; k < size; k++)
			out[i * size + k] = k < comps ? src[i * comps + k] / div : fill;
	return out;
}

/** glTF local transform (matrix, else TRS) as a column-major array, or null for identity. */
export function nodeMatrix(node: GltfNode): number[] | null {
	if (node.matrix && node.matrix.length === 16) {
		const m = Array.from(node.matrix);
		return isIdentity(m) ? null : m;
	}
	const t = node.translation;
	const r = node.rotation;
	const s = node.scale;
	if (!t && !r && !s) return null;
	const [x, y, z, w] = r ?? [0, 0, 0, 1];
	const [sx, sy, sz] = s ?? [1, 1, 1];
	const [tx, ty, tz] = t ?? [0, 0, 0];
	const m = [
		(1 - 2 * (y * y + z * z)) * sx,
		2 * (x * y + z * w) * sx,
		2 * (x * z - y * w) * sx,
		0,
		2 * (x * y - z * w) * sy,
		(1 - 2 * (x * x + z * z)) * sy,
		2 * (y * z + x * w) * sy,
		0,
		2 * (x * z + y * w) * sz,
		2 * (y * z - x * w) * sz,
		(1 - 2 * (x * x + y * y)) * sz,
		0,
		tx,
		ty,
		tz,
		1,
	];
	return isIdentity(m) ? null : m;
}

function isIdentity(m: ArrayLike<number>): boolean {
	for (let i = 0; i < 16; i++) if (m[i] !== (i % 5 === 0 ? 1 : 0)) return false;
	return true;
}

function sphereOfPositions(p: Float32Array, a?: Accessor): Sphere | null {
	let lo: number[];
	let hi: number[];
	if (a?.min && a.max && a.min.length >= 3) {
		lo = a.min;
		hi = a.max;
	} else {
		if (!p.length) return null;
		lo = [Infinity, Infinity, Infinity];
		hi = [-Infinity, -Infinity, -Infinity];
		for (let i = 0; i < p.length; i += 3)
			for (let k = 0; k < 3; k++) {
				lo[k] = Math.min(lo[k], p[i + k]);
				hi[k] = Math.max(hi[k], p[i + k]);
			}
	}
	const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
	return [
		c[0],
		c[1],
		c[2],
		Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2,
	];
}

/** Sphere enclosing `s` placed at each instance matrix (translation + largest axis scale). */
function sphereOfInstances(
	s: Sphere,
	inst: Float32Array,
	count: number,
): Sphere {
	const lo = [Infinity, Infinity, Infinity];
	const hi = [-Infinity, -Infinity, -Infinity];
	let scale = 0;
	const centres = new Float64Array(count * 3);
	for (let i = 0; i < count; i++) {
		const m = inst.subarray(i * 16, i * 16 + 16);
		const c = [
			m[0] * s[0] + m[4] * s[1] + m[8] * s[2] + m[12],
			m[1] * s[0] + m[5] * s[1] + m[9] * s[2] + m[13],
			m[2] * s[0] + m[6] * s[1] + m[10] * s[2] + m[14],
		];
		for (let k = 0; k < 3; k++) {
			centres[i * 3 + k] = c[k];
			lo[k] = Math.min(lo[k], c[k]);
			hi[k] = Math.max(hi[k], c[k]);
		}
		scale = Math.max(
			scale,
			Math.hypot(m[0], m[1], m[2]),
			Math.hypot(m[4], m[5], m[6]),
			Math.hypot(m[8], m[9], m[10]),
		);
	}
	const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
	let r = 0;
	for (let i = 0; i < count; i++)
		r = Math.max(
			r,
			Math.hypot(
				centres[i * 3] - c[0],
				centres[i * 3 + 1] - c[1],
				centres[i * 3 + 2] - c[2],
			),
		);
	return [c[0], c[1], c[2], r + s[3] * scale];
}

function isWhite(c: number[]): boolean {
	return c[0] === 1 && c[1] === 1 && c[2] === 1;
}

/** An image as the layers can upload it, or null (not decoded / empty). */
function imageOf(image: unknown): TileImage | null {
	const img = image as {
		width?: number;
		height?: number;
		data?: unknown;
	} | null;
	if (!img || !(Number(img.width) > 0)) return null;
	// a loaders.gl image object wraps the decoded bitmap in `data`
	const inner = img.data as TileImage | undefined;
	if (
		inner &&
		!ArrayBuffer.isView(inner) &&
		Number((inner as { width?: number }).width) > 0
	)
		return inner;
	return image as TileImage;
}

/** Close a decoded image's pixel memory (ImageBitmap), when the tile unloads. */
export function releaseImage(image: TileImage | null) {
	(image as { close?: () => void } | null)?.close?.();
}

let meshCounter = 0;

/**
 * The drawable meshes of one loaded tile.
 * @param enuFromEcef the source's ENU ← ECEF placement (frame.ts)
 */
export function tileMeshesFromContent(
	content: TileContentLike,
	enuFromEcef: Matrix4,
	source: Tiles3DSource,
	depthBias: number,
	/** The tile's ECEF placement (Tile3D.computedTransform); only i3dm needs it. */
	tileTransform?: ArrayLike<number>,
): TileMesh[] {
	const gltf = content.gltf;
	if (!gltf) return [];
	const sceneRef = gltf.scene;
	const scene =
		typeof sceneRef === "object" && sceneRef
			? sceneRef
			: gltf.scenes?.[typeof sceneRef === "number" ? sceneRef : 0];
	const instances = content.instances?.length ? content.instances : null;
	// plain meshes: ENU <- ECEF x the loader's whole placement (tile transform, RTC, glTF up axis)
	const tile = new Matrix4(enuFromEcef);
	if (!instances && content.cartesianModelMatrix)
		tile.multiplyRight(content.cartesianModelMatrix as number[]);
	// i3dm: instances live in the tile frame and apply AFTER the glTF up-axis rotation (which stays
	// with the vertices), and their translations are ECEF-scale (swisstopo vegetation: about 4e6 m):
	// compose ENU <- ECEF x tile transform x RTC x instance per instance in float64 and keep only
	// ENU-sized values for the GPU
	const instanceMatrices = instances
		? new Float32Array(instances.length * 16)
		: null;
	let upAxis: Matrix4 | null = null;
	if (instances && instanceMatrices) {
		if (tileTransform) tile.multiplyRight(Array.from(tileTransform));
		if (content.rtcCenter) tile.translate(Array.from(content.rtcCenter));
		upAxis = upAxisRotation(content.gltfUpAxis);
		instances.forEach((inst, i) => {
			const m = inst.modelMatrix;
			const world = m
				? new Matrix4(tile).multiplyRight(Array.from(m).slice(0, 16))
				: tile;
			instanceMatrices.set(Array.from(world as unknown as number[]), i * 16);
		});
	}
	const out: TileMesh[] = [];
	// `chain` = the glTF node chain below the tile placement (null = identity; i3dm starts at the up axis)
	const visit = (node: GltfNode, chain: Matrix4 | null) => {
		const local = nodeMatrix(node);
		const next = local
			? (chain ? new Matrix4(chain) : new Matrix4()).multiplyRight(local)
			: chain;
		for (const prim of node.mesh?.primitives ?? []) {
			const mesh = meshFromPrimitive(
				prim,
				// instanced: instances apply before the node chain, so it moves into the vertices
				instanceMatrices
					? IDENTITY_MATRIX
					: next
						? new Matrix4(tile).multiplyRight(next as unknown as number[])
						: tile,
				instanceMatrices && next
					? (Array.from(next as unknown as number[]) as number[])
					: null,
				instanceMatrices,
				source,
				depthBias,
			);
			if (mesh) out.push(mesh);
		}
		for (const child of node.children ?? []) visit(child, next);
	};
	for (const node of scene?.nodes ?? []) visit(node, upAxis);
	return out;
}

const IDENTITY_MATRIX = new Matrix4();

/** The glTF -> Z-up rotation of the 3D Tiles spec (Y-up models turn about X), null when none. */
function upAxisRotation(axis: string | undefined): Matrix4 | null {
	switch (axis) {
		case "Z":
			return null;
		case "X":
			return new Matrix4().rotateY(-Math.PI / 2);
		default:
			return new Matrix4().rotateX(Math.PI / 2);
	}
}

function meshFromPrimitive(
	prim: Primitive,
	matrix: Matrix4,
	bake: number[] | null,
	instances: Float32Array | null,
	source: Tiles3DSource,
	depthBias: number,
): TileMesh | null {
	if ((prim.mode ?? 4) !== 4) return null; // triangle lists only
	const pos = prim.attributes.POSITION;
	if (!pos?.count) return null;
	let positions = accessorFloats(pos, 3, 0);
	if (bake) {
		const m = bake;
		const baked = new Float32Array(positions.length);
		for (let i = 0; i < positions.length; i += 3) {
			const x = positions[i];
			const y = positions[i + 1];
			const z = positions[i + 2];
			baked[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
			baked[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
			baked[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
		}
		positions = baked;
	}
	const uv = prim.attributes.TEXCOORD_0;
	const col = prim.attributes.COLOR_0;
	let indices: Uint16Array | Uint32Array | null = null;
	if (prim.indices) {
		const v = prim.indices.value;
		indices =
			v instanceof Uint16Array || v instanceof Uint32Array
				? v
				: new Uint32Array(Array.from(v));
	}
	const pbr = prim.material?.pbrMetallicRoughness;
	const image = imageOf(pbr?.baseColorTexture?.texture?.source?.image);
	const factor = pbr?.baseColorFactor;
	const color: Vec3 =
		factor && !image && !isWhite(factor)
			? [factor[0], factor[1], factor[2]]
			: source.fallbackColor;
	let sphere = sphereOfPositions(positions, bake ? undefined : pos);
	const instanceCount = instances ? instances.length / 16 : 0;
	if (sphere && instances)
		sphere = sphereOfInstances(sphere, instances, instanceCount);
	return {
		key: `${source.id}-${meshCounter++}`,
		source,
		positions,
		uvs: uv ? accessorFloats(uv, 2, 0) : null,
		colors: col ? accessorFloats(col, 3, 1) : null,
		indices,
		matrix: Array.from(matrix as ArrayLike<number>),
		instances,
		instanceCount,
		image,
		color,
		depthBias,
		boundingSphere: sphere,
	};
}
