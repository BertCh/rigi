// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { sceneAt } from "../harness/lib/geo";

const ids = process.argv.slice(2);
const man: {
	id: string;
	lat: number;
	lon: number;
	altitudeM?: number | null;
}[] = JSON.parse(
	fs.readFileSync(
		fileURLToPath(new URL("../data/manifest.json", import.meta.url)),
		"utf8",
	),
);
for (const id of ids) {
	const e = man.find((x) => x.id === id);
	if (!e) throw new Error(`unknown manifest id ${id}`); // invariant: ids come from manifest.json
	const s = await sceneAt(e.lat, e.lon, e.altitudeM ?? null);
	console.log(JSON.stringify({ id, ground: s.ground, eye: s.eye }));
}
