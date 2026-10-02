// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Live probe of the tile pipeline in node (network, no browser, no GPU): streams swisstopo 3D Tiles
// through Tiles3DSet (loaders.gl Tileset3D + our ENU viewport) around a point and prints the TileMeshes
// that would be drawn. Draco comes from the `draco3d` package here (the browser loads public/tiles3d/draco).
//   npx tsx scripts/tiles3d/stream-probe.ts [lat] [lon] [buildings|vegetation]
import { TILES3D_SOURCES } from "../../src/lib/tiles3d/config";
import { Tiles3DSet } from "../../src/lib/tiles3d/tiles";

const lat = Number(process.argv[2] ?? 46.7);
const lon = Number(process.argv[3] ?? 7.8);
const source =
	process.argv[4] === "vegetation"
		? "swisstopo-vegetation"
		: "swisstopo-buildings";
const draco3d = await import("draco3d" as string).then((m) => m.default ?? m);
const eye: [number, number, number] = [0, 0, 1500];
const set = new Tiles3DSet(
	{ sources: [source], blend: "fill", radius: 3000, fadeStart: 2200 },
	{ lat, lon, eye },
	{},
	// node has no ImageBitmap: skip texture decoding here (the browser decodes them)
	{ loadOptions: { modules: { draco3d }, gltf: { loadImages: false } } },
);
// camera at the eye looking north, ENU world -> camera (column-major, looks down -Z)
const view = {
	position: eye,
	viewMatrix: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1].map((v, i) =>
		i === 14 ? 0 : v,
	),
	projectionMatrix: new Array(16).fill(0),
	fovY: 60,
	aspect: 1.5,
};
for (let i = 0; i < 12; i++) {
	set.update(view, 900, 600);
	await new Promise((r) => setTimeout(r, 2000));
	const meshes = set.visibleMeshes();
	console.log(`${i}: ${meshes.length} meshes, ${JSON.stringify(set.stats())}`);
}
const [m] = set.visibleMeshes();
if (m)
	console.log(
		"first mesh",
		{
			vertices: m.positions.length / 3,
			indices: m.indices?.length,
			color: m.color,
			instances: m.instanceCount,
			textured: !!m.image,
			sphere: m.boundingSphere,
		},
		"matrix translation",
		Array.from(m.matrix).slice(12, 15),
	);
console.log(TILES3D_SOURCES[source].credit, "|", set.attributions());
set.dispose();
process.exit(0);
