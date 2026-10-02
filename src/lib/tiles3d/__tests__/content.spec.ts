// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Matrix4 } from "@math.gl/core";
import { describe, expect, it } from "vitest";
import { TILES3D_SOURCES } from "../config";
import {
	accessorFloats,
	nodeMatrix,
	releaseImage,
	type TileContentLike,
	tileMeshesFromContent,
} from "../content";

const SOURCE = TILES3D_SOURCES["swisstopo-buildings"];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translate = (x: number, y: number, z: number) =>
	new Matrix4().translate([x, y, z]);

const prim = (extra: Record<string, unknown> = {}) => ({
	attributes: {
		POSITION: {
			value: new Float32Array([0, 0, 0, 2, 0, 0, 0, 4, 0]),
			count: 3,
			size: 3,
			min: [0, 0, 0],
			max: [2, 4, 0],
		},
	},
	...extra,
});
const content = (
	nodes: unknown[],
	extra: Partial<TileContentLike> = {},
): TileContentLike => ({
	cartesianModelMatrix: IDENTITY,
	gltf: { scenes: [{ nodes: nodes as never }] },
	...extra,
});

describe("accessorFloats", () => {
	it("passes a tight Float32Array through and widens or fills lanes", () => {
		const f = new Float32Array([1, 2, 3]);
		expect(accessorFloats({ value: f, count: 1, size: 3 }, 3)).toBe(f);
		expect(
			Array.from(
				accessorFloats(
					{ value: new Float32Array([1, 2, 3, 4]), count: 2, size: 2 },
					3,
					9,
				),
			),
		).toEqual([1, 2, 9, 3, 4, 9]);
	});
	it("takes rgb of rgba and normalises integer colours only when flagged", () => {
		const rgba = new Uint8Array([255, 0, 51, 255]);
		expect(
			Array.from(
				accessorFloats(
					{
						value: rgba,
						count: 1,
						size: 4,
						componentType: 5121,
						normalized: true,
					},
					3,
				),
			),
		).toEqual([1, 0, expect.closeTo(0.2, 5)]);
		expect(
			Array.from(
				accessorFloats(
					{
						value: new Int16Array([10, -20, 30]),
						count: 1,
						size: 3,
						componentType: 5122,
					},
					3,
				),
			),
		).toEqual([10, -20, 30]);
	});
});

describe("nodeMatrix", () => {
	it("is null for identity and absent transforms", () => {
		expect(nodeMatrix({})).toBeNull();
		expect(nodeMatrix({ matrix: IDENTITY })).toBeNull();
		expect(
			nodeMatrix({
				translation: [0, 0, 0],
				rotation: [0, 0, 0, 1],
				scale: [1, 1, 1],
			}),
		).toBeNull();
	});
	it("composes translation, rotation and scale as column-major TRS", () => {
		// 90 degrees about z: x -> y
		const s = Math.SQRT1_2;
		const m = nodeMatrix({
			translation: [1, 2, 3],
			rotation: [0, 0, s, s],
			scale: [2, 2, 2],
		}) as number[];
		const p = new Matrix4(m).transformAsPoint([1, 0, 0]) as number[];
		expect(p[0]).toBeCloseTo(1, 6);
		expect(p[1]).toBeCloseTo(4, 6);
		expect(p[2]).toBeCloseTo(3, 6);
	});
	it("prefers an explicit matrix", () => {
		const m = translate(5, 0, 0);
		expect(
			nodeMatrix({ matrix: Array.from(m) as number[], translation: [9, 9, 9] }),
		).toEqual(Array.from(m));
	});
});

describe("tileMeshesFromContent", () => {
	it("composes ENU <- ECEF x tile placement x node chain in float64", () => {
		const enu = translate(100, 0, 0);
		const c = content(
			[
				{
					translation: [0, 10, 0],
					children: [
						{ translation: [0, 0, 1], mesh: { primitives: [prim()] } },
					],
				},
			],
			{ cartesianModelMatrix: Array.from(translate(0, 1000, 0)) as number[] },
		);
		const [mesh] = tileMeshesFromContent(c, enu, SOURCE, 0.99);
		const p = new Matrix4(Array.from(mesh.matrix) as number[]).transformAsPoint(
			[0, 0, 0],
		) as number[];
		expect(p).toEqual([100, 1010, 1]);
		expect(mesh.depthBias).toBe(0.99);
		expect(mesh.source).toBe(SOURCE);
		expect(mesh.instances).toBeNull();
		expect(mesh.boundingSphere?.[3]).toBeCloseTo(Math.hypot(2, 4) / 2, 6);
	});

	it("keeps large (ECEF-scale) translations out of the vertices", () => {
		const big = translate(4.3e6, 0.6e6, 4.6e6);
		const inv = new Matrix4(big).invert();
		const [mesh] = tileMeshesFromContent(
			content([{ mesh: { primitives: [prim()] } }], {
				cartesianModelMatrix: Array.from(big) as number[],
			}),
			inv,
			SOURCE,
			1,
		);
		expect(Array.from(mesh.positions).every((v) => Math.abs(v) < 10)).toBe(
			true,
		);
		expect(mesh.matrix[12]).toBeCloseTo(0, 6);
	});

	it("skips non-triangle primitives and empty positions, and reads uv, colour and indices", () => {
		const uv = {
			value: new Float32Array([0, 0, 1, 0, 0, 1]),
			count: 3,
			size: 2,
		};
		const color = { value: new Float32Array(9).fill(0.5), count: 3, size: 3 };
		const idx = new Uint16Array([0, 1, 2]);
		const meshes = tileMeshesFromContent(
			content([
				{
					mesh: {
						primitives: [
							prim({ mode: 1 }),
							{
								attributes: {
									POSITION: { value: new Float32Array(0), count: 0, size: 3 },
								},
							},
							{
								...prim(),
								attributes: {
									...prim().attributes,
									TEXCOORD_0: uv,
									COLOR_0: color,
								},
								indices: { value: idx, count: 3 },
							},
						],
					},
				},
			]),
			new Matrix4(),
			SOURCE,
			1,
		);
		expect(meshes).toHaveLength(1);
		expect(meshes[0].uvs).toBe(uv.value);
		expect(meshes[0].colors).toBe(color.value);
		expect(meshes[0].indices).toBe(idx);
	});

	it("colour: a coloured factor is kept, white or missing falls back, a texture wins", () => {
		const image = { width: 8, height: 8 };
		const m = (pbr: unknown) =>
			tileMeshesFromContent(
				content([
					{
						mesh: {
							primitives: [prim({ material: { pbrMetallicRoughness: pbr } })],
						},
					},
				]),
				new Matrix4(),
				SOURCE,
				1,
			)[0];
		expect(m({ baseColorFactor: [0.2, 0.4, 0.6, 1] }).color).toEqual([
			0.2, 0.4, 0.6,
		]);
		expect(m({ baseColorFactor: [1, 1, 1, 1] }).color).toEqual(
			SOURCE.fallbackColor,
		);
		expect(m({}).color).toEqual(SOURCE.fallbackColor);
		const textured = m({
			baseColorFactor: [0.2, 0.4, 0.6, 1],
			baseColorTexture: { texture: { source: { image } } },
		});
		expect(textured.image).toBe(image);
		expect(textured.color).toEqual(SOURCE.fallbackColor);
	});

	it("unwraps a loaders.gl image object and ignores an empty one", () => {
		const bitmap = { width: 4, height: 4 };
		const m = (image: unknown) =>
			tileMeshesFromContent(
				content([
					{
						mesh: {
							primitives: [
								prim({
									material: {
										pbrMetallicRoughness: {
											baseColorTexture: { texture: { source: { image } } },
										},
									},
								}),
							],
						},
					},
				]),
				new Matrix4(),
				SOURCE,
				1,
			)[0].image;
		expect(m({ width: 4, height: 4, data: bitmap })).toBe(bitmap);
		const raw = { width: 2, height: 2, data: new Uint8Array(16) };
		expect(m(raw)).toBe(raw);
		expect(m({ width: 0, height: 0 })).toBeNull();
		expect(m(null)).toBeNull();
	});

	it("i3dm: carries instance matrices, bakes the node chain into the vertices, bounds all instances", () => {
		const inst = [
			{ modelMatrix: Array.from(translate(10, 0, 0)) },
			{ modelMatrix: Array.from(translate(-10, 0, 0)) },
		];
		const [mesh] = tileMeshesFromContent(
			content([{ translation: [0, 0, 5], mesh: { primitives: [prim()] } }], {
				instances: inst as never,
				gltfUpAxis: "Z",
			}),
			new Matrix4(),
			SOURCE,
			1,
		);
		expect(mesh.instanceCount).toBe(2);
		expect(mesh.instances).toHaveLength(32);
		expect(mesh.instances?.[12]).toBe(10);
		// the node's z offset moved into the vertices; the model matrix stays the tile placement
		expect(mesh.positions[2]).toBe(5);
		expect(Array.from(mesh.matrix)).toEqual(IDENTITY);
		const s = mesh.boundingSphere as number[];
		expect(s[0]).toBeCloseTo(1, 6); // midway between the two instance centres (11, -9)
		expect(s[3]).toBeGreaterThan(10);
	});

	it("i3dm: composes the ECEF-scale instance placement in float64 so the GPU only sees ENU-sized values", () => {
		const big = translate(4.3e6, 0.6e6, 4.6e6);
		const inv = new Matrix4(big).invert();
		const [mesh] = tileMeshesFromContent(
			content([{ mesh: { primitives: [prim()] } }], {
				instances: [
					{
						modelMatrix: Array.from(
							translate(4.3e6 + 12, 0.6e6 - 3, 4.6e6 + 5),
						),
					},
				] as never,
			}),
			inv,
			SOURCE,
			1,
		);
		const t = (mesh.instances as Float32Array).slice(12, 15);
		expect(Array.from(t)).toEqual([12, -3, 5]);
		expect(Array.from(mesh.matrix)).toEqual(IDENTITY);
	});

	it("i3dm: the glTF up-axis rotation stays with the vertices, the instance applies after it; tile transform and RTC offset the frame", () => {
		const [mesh] = tileMeshesFromContent(
			content([{ mesh: { primitives: [prim()] } }], {
				instances: [{ modelMatrix: Array.from(translate(1, 0, 0)) }] as never,
				rtcCenter: [10, 0, 0],
			}),
			new Matrix4(),
			SOURCE,
			1,
			Array.from(translate(0, 100, 0)),
		);
		// Y-up -> Z-up: the vertex (0, 4, 0) turns to (0, 0, 4)
		expect(Array.from(mesh.positions.slice(6, 9)).map(Math.round)).toEqual([
			0, 0, 4,
		]);
		// frame = tile transform (0,100,0) x RTC (10,0,0) x instance (1,0,0)
		expect(Array.from((mesh.instances as Float32Array).slice(12, 15))).toEqual([
			11, 100, 0,
		]);
	});

	it("an instanced mesh without a node transform keeps the vertices untouched", () => {
		const p = prim();
		const [mesh] = tileMeshesFromContent(
			content([{ mesh: { primitives: [p] } }], {
				instances: [{ modelMatrix: IDENTITY }] as never,
				gltfUpAxis: "Z",
			}),
			new Matrix4(),
			SOURCE,
			1,
		);
		expect(mesh.positions).toBe(p.attributes.POSITION.value);
	});

	it("returns nothing for content without a glTF", () => {
		expect(tileMeshesFromContent({}, new Matrix4(), SOURCE, 1)).toEqual([]);
	});

	it("gives every mesh a unique key", () => {
		const meshes = tileMeshesFromContent(
			content([{ mesh: { primitives: [prim(), prim()] } }]),
			new Matrix4(),
			SOURCE,
			1,
		);
		expect(new Set(meshes.map((m) => m.key)).size).toBe(2);
	});
});

describe("releaseImage", () => {
	it("closes an ImageBitmap-like and tolerates plain images and null", () => {
		let closed = 0;
		releaseImage({ width: 1, height: 1, close: () => closed++ } as never);
		releaseImage({ width: 1, height: 1, data: new Uint8Array(4) });
		releaseImage(null);
		expect(closed).toBe(1);
	});
});
