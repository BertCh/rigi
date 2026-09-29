/** Node-only Overpass fetch of OSM peaks with a disk cache in .cache/overpass. */
import fs from "node:fs";
import path from "node:path";
import {
	overpassPeaksQuery,
	type Peak,
	parseOverpassPeaks,
} from "../../src/lib/geo/peaks";
import { OVERPASS, overpass } from "../../src/lib/overpass";
import { CACHE } from "./node-io";

const USER_AGENT =
	"mt-image-baseline/0.1 (mountain photo georeferencing research)";

/** Peaks within `radiusM` of (lat, lon); cached per rounded location. */
export async function fetchPeaks(
	lat: number,
	lon: number,
	radiusM = 80_000,
): Promise<Peak[]> {
	// Round to ~1 km so nearby photos share one query.
	const key = `${lat.toFixed(2)},${lon.toFixed(2)},${Math.round(radiusM / 1000)}km`;
	const file = path.join(CACHE, "overpass", `${key}.json`);
	if (!fs.existsSync(file)) {
		const query = overpassPeaksQuery(+lat.toFixed(2), +lon.toFixed(2), radiusM);
		// Be polite: one instance, backing off 10 s, 20 s on 429/504.
		const json = await overpass(query, {
			endpoints: [OVERPASS.main, OVERPASS.main, OVERPASS.main],
			userAgent: USER_AGENT,
			backoffMs: 10_000,
		});
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(json));
	}
	return parseOverpassPeaks(JSON.parse(fs.readFileSync(file, "utf8")));
}
