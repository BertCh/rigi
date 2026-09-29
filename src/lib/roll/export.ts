// Roll → GeoJSON: every camera (point + pose), its view wedge, and the day's track, so a roll can
// be opened in any GIS / web map (QGIS, geojson.io, Mapillary-style viewers).
import { destination } from "../geodesy";
import { hfovOf } from "./roll";
import type { Roll } from "./types";

/** Radius (m) of the drawn view wedges: a symbol, not a visibility claim. */
const WEDGE_M = 400;

type Feature = {
	type: "Feature";
	geometry: { type: string; coordinates: unknown };
	properties: Record<string, unknown>;
};

export function rollToGeoJSON(roll: Roll) {
	const features: Feature[] = [];
	for (const p of roll.photos) {
		const m = p.meta;
		const props = {
			id: m.id,
			takenAt: m.takenAt,
			viewpoint: p.viewpoint,
			poseSource: p.poseSource,
			confidence: p.confidence,
			yaw: round(p.pose.yaw, 2),
			pitch: round(p.pose.pitch, 2),
			roll: round(p.pose.roll, 2),
			vfov: round(p.pose.vfov, 2),
			hfov: round(hfovOf(p.pose, m.width / m.height), 2),
			altitude: m.alt,
		};
		features.push({
			type: "Feature",
			geometry: { type: "Point", coordinates: [m.lon, m.lat] },
			properties: { kind: "camera", ...props },
		});
		const hf = Math.min(179, props.hfov);
		const ring: [number, number][] = [[m.lon, m.lat]];
		for (let i = 0; i <= 12; i++) {
			const d = destination(
				m.lat,
				m.lon,
				p.pose.yaw - hf / 2 + (hf * i) / 12,
				WEDGE_M,
			);
			ring.push([d.lon, d.lat]);
		}
		ring.push([m.lon, m.lat]);
		features.push({
			type: "Feature",
			geometry: { type: "Polygon", coordinates: [ring] },
			properties: { kind: "view", id: m.id },
		});
	}
	if (roll.photos.length > 1)
		features.push({
			type: "Feature",
			geometry: {
				type: "LineString",
				coordinates: roll.photos.map((p) => [p.meta.lon, p.meta.lat]),
			},
			properties: { kind: "track", name: roll.name },
		});
	return { type: "FeatureCollection", name: roll.name, features };
}

/** Download the roll's GeoJSON (browser only). */
export function downloadRollGeoJSON(roll: Roll) {
	const blob = new Blob([JSON.stringify(rollToGeoJSON(roll), null, 1)], {
		type: "application/geo+json",
	});
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `${roll.id}.geojson`;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
