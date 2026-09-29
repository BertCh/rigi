import fs from "node:fs";
import { sceneAt } from "/Users/robertchristie/Documents/GitHub/mt-image/tools/bench/harness/lib/geo";
const ids = process.argv.slice(2);
const man = JSON.parse(
	fs.readFileSync(
		"/Users/robertchristie/Documents/GitHub/mt-image/tools/bench/data/manifest.json",
		"utf8",
	),
);
for (const id of ids) {
	const e = man.find((x: any) => x.id === id);
	const s = await sceneAt(e.lat, e.lon, e.altitudeM ?? null);
	console.log(JSON.stringify({ id, ground: s.ground, eye: s.eye }));
}
