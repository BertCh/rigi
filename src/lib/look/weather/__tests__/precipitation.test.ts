// Pins the precipitation lattice: deterministic, inside the volume around the camera, world-anchored
// (moving the camera by a whole cell changes nothing), and the drift wraps.
// Run: npx tsx src/lib/look/weather/__tests__/precipitation.test.ts   (exits 1 on failure)
import {
	PRECIPITATION_SEED,
	precipitationDrift,
	precipitationFor,
	precipitationPosition,
	precipitationRandom,
} from "../precipitation";

let bad = 0;
const check = (name: string, ok: boolean) => {
	if (!ok) bad++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
};

const size: [number, number, number] = [400, 400, 240];
const center: [number, number, number] = [120, -80, 1500];
const drift: [number, number, number] = [10, 20, 30];

let inside = true;
let anchored = true;
for (let id = 0; id < 2000; id++) {
	const p = precipitationPosition(id, center, size, drift);
	for (let k = 0; k < 3; k++)
		if (Math.abs(p[k] - center[k]) > size[k] / 2 + 1e-6) inside = false;
	const q = precipitationPosition(
		id,
		[center[0] + size[0], center[1], center[2]],
		size,
		drift,
	);
	// shifting the centre by one cell moves the image by exactly one cell
	if (Math.abs(q[0] - p[0] - size[0]) > 1e-6 || q[1] !== p[1]) anchored = false;
}
check("positions stay inside the volume", inside);
check("lattice is world-anchored", anchored);
let mean = 0;
let inRange = true;
for (let i = 0; i < 4000; i++) {
	const r = precipitationRandom(i, PRECIPITATION_SEED);
	if (!(r >= 0 && r < 1)) inRange = false;
	mean += r / 4000;
}
check("hash in [0,1), mean near 0.5", inRange && Math.abs(mean - 0.5) < 0.03);
const d = precipitationDrift(
	{ fallSpeed: 9, wind: [3, 1], volumeM: 400 },
	12345.6,
);
check(
	"drift reduced modulo the volume",
	d[0] >= 0 && d[0] < 400 && d[2] >= 0 && d[2] < 240,
);
check("off -> null", precipitationFor({ mode: "off" }) === null);
check(
	"rain count follows intensity",
	precipitationFor({ mode: "rain", intensity: 0.5, wind: 0 })?.count === 4500,
);
process.exit(bad ? 1 : 0);
