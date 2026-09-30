// npx tsx src/lib/geocam/lakes/lakes.check.ts — synthetic tests for compact / levels / floor / fetch
// (Agent A's part of src/lib/geocam/lakes; factors.ts has its own lakes-factors.check.ts). Exit 1 on failure.
import {
	_resetLakesMemo,
	candidateLakes,
	compactLakes,
	enuAround,
	floorRadius,
	LAKE_FLOOR_DEFAULTS,
	lakeFloor,
	lakeFloorDetail,
	lakeLevelOf,
	lakesNear,
	photoLakeFloor,
	type SceneLake,
	tableLevel,
	toSceneLakes,
	type WaterElement,
} from "./index";

let fails = 0;
const ok = (cond: boolean, msg: string) => {
	if (!cond) {
		fails++;
		console.error(`FAIL ${msg}`);
	}
};
const near = (a: number | null | undefined, b: number, tol = 1e-6) =>
	a != null && Math.abs(a - b) <= tol;

// ---- synthetic OSM around (46.70, 7.75)
const LAT0 = 46.7;
const LON0 = 7.75;
const mPerDegLat = 111_195;
const mPerDegLon = 111_195 * Math.cos((LAT0 * Math.PI) / 180);
const ll = (e: number, n: number) => ({
	lat: LAT0 + n / mPerDegLat,
	lon: LON0 + e / mPerDegLon,
});
const ring = (pts: [number, number][]) =>
	[...pts, pts[0]].map(([e, n]) => ll(e, n));
const circle = (ce: number, cn: number, r: number, k: number) =>
	ring(
		Array.from({ length: k }, (_, i) => {
			const a = (2 * Math.PI * i) / k;
			return [ce + r * Math.cos(a), cn + r * Math.sin(a)] as [number, number];
		}),
	);

// lake A: 1 km × 1 km square (e 0..1000, n 0..1000), ele 558, dense edges; island 400..600 as an inner member
const sq = (e0: number, n0: number, e1: number, n1: number, step = 50) => {
	const p: [number, number][] = [];
	for (let e = e0; e < e1; e += step) p.push([e, n0]);
	for (let n = n0; n < n1; n += step) p.push([e1, n]);
	for (let e = e1; e > e0; e -= step) p.push([e, n1]);
	for (let n = n1; n > n0; n -= step) p.push([e0, n]);
	return p;
};
const outerA = ring(sq(0, 0, 1000, 1000));
const els: WaterElement[] = [
	{
		type: "relation",
		id: 1,
		tags: { natural: "water", water: "lake", name: "Testsee", ele: "558" },
		members: [
			// the outer ring split into two open ways (stitching)
			{ role: "outer", geometry: outerA.slice(0, 40) },
			{ role: "outer", geometry: outerA.slice(39) },
			{ role: "inner", geometry: ring(sq(400, 400, 600, 600)) },
		],
	},
	// a dense circle lake (r 300 m, 720 vertices) without ele, name from the Swiss table
	{
		type: "way",
		id: 2,
		tags: { natural: "water", name: "Bielersee / Lac de Bienne" },
		geometry: circle(3000, 0, 300, 720),
	},
	// a river polygon: excluded (not horizontal)
	{
		type: "way",
		id: 3,
		tags: { natural: "water", water: "river", name: "Aare" },
		geometry: ring(sq(-2000, -2000, 0, -1900)),
	},
	// a pond below the area cut (100 × 100 m)
	{
		type: "way",
		id: 4,
		tags: { natural: "water", name: "Weiher" },
		geometry: ring(sq(-500, 0, -400, 100)),
	},
	// a reservoir (kept by compact, skipped by the floor), ele 700
	{
		type: "way",
		id: 5,
		tags: { natural: "water", water: "reservoir", name: "Stausee", ele: "700" },
		geometry: ring(sq(0, 3000, 1000, 4000)),
	},
	// duplicate of 2 (a second cached file): de-duplicated
	{
		type: "way",
		id: 2,
		tags: { natural: "water", name: "Bielersee / Lac de Bienne" },
		geometry: circle(3000, 0, 300, 720),
	},
	// not water
	{
		type: "way",
		id: 6,
		tags: { landuse: "grass" },
		geometry: ring(sq(0, 0, 10, 10)),
	},
];

const lakes = compactLakes(els);
ok(lakes.length === 3, `compact keeps 3 still lakes (got ${lakes.length})`);
const A = lakes.find((l) => l.id === "relation/1");
const C = lakes.find((l) => l.id === "way/2");
const Rsv = lakes.find((l) => l.id === "way/5");
ok(!!A && !!C && !!Rsv, "ids");
ok(A?.ele === 558 && A.water === "lake" && A.name === "Testsee", "tags kept");
ok((A?.holes?.length ?? 0) === 1, "inner ring kept as a hole");
ok(near(A?.areaM2 ?? 0, 1e6, 2e3), `area A ≈ 1 km² (${A?.areaM2})`);
// collinear edge vertices collapse to the 4 corners (+ the ring's start vertex, always kept)
const nA = (A?.outer.length ?? 0) / 2;
ok(nA >= 4 && nA <= 5, `square simplified 80 → ${nA}`);
const nC = (C?.outer.length ?? 0) / 2;
ok(nC >= 8 && nC < 100, `circle simplified 720 → ${nC}`);
// simplified circle within tol (10 m) of the true radius
if (C) {
	const toEN = enuAround(LAT0, LON0);
	let worst = 0;
	for (let i = 0; i < C.outer.length; i += 2) {
		const [e, n] = toEN(C.outer[i], C.outer[i + 1]);
		worst = Math.max(worst, Math.abs(Math.hypot(e - 3000, n) - 300));
	}
	ok(worst < 1, `kept vertices on the circle (${worst.toFixed(2)} m)`);
}
ok(
	JSON.stringify(lakes).length < 4000,
	`compact JSON small (${JSON.stringify(lakes).length} B)`,
);

// ---- levels
ok(lakeLevelOf({ ele: 558, name: "Thunersee" })?.source === "osm", "ele wins");
const tl = lakeLevelOf({ ele: null, name: "Thunersee" });
ok(
	tl?.source === "table" && near(tl.levelM, 557.8, 0.01),
	"Swiss table by name",
);
ok(tableLevel("Bielersee / Lac de Bienne")?.levelM === 429.1, "bilingual name");
ok(tableLevel("Vierwaldstättersee") != null, "diacritics");
ok(tableLevel("Lac Léman") != null, "Léman");
ok(tableLevel("Unknownsee") == null, "no false table hit");
let demCalls = 0;
const dl = lakeLevelOf({ ele: null, name: "Unknownsee" }, () => {
	demCalls++;
	return 612.4;
});
ok(
	dl?.source === "dem" && dl.levelM === 612.4 && demCalls === 1,
	"DEM fallback",
);
lakeLevelOf({ ele: 5, name: "x" }, () => {
	demCalls++;
	return 1;
});
ok(demCalls === 1, "DEM thunk not evaluated when ele exists");
ok(lakeLevelOf({ ele: null }) === null, "no level → null");

// ---- scene lakes + floor rule
const toEN = enuAround(LAT0, LON0);
const scene = toSceneLakes(lakes, toEN, (l) => lakeLevelOf(l));
const sA = scene.find((l) => l.id === "relation/1") as SceneLake;
ok(sA.levelM === 558 && sA.levelSource === "osm", "scene level");
ok(
	scene.find((l) => l.id === "way/2")?.levelSource === "table",
	"table level in scene",
);
const R0 = floorRadius(14);
ok(R0 === 44, `radius(hAcc 14) = 44 (got ${R0})`);
ok(
	floorRadius(null) === 50 && floorRadius(1) === 35 && floorRadius(500) === 130,
	"radius clamp",
);
const M = LAKE_FLOOR_DEFAULTS.marginM;
// (a) inside the water: floor even with the DEM far below (bathymetry) or unknown
ok(near(lakeFloor(scene, [200, 200], {}), 558 + M), "inside, no DEM → floor");
ok(
	near(lakeFloor(scene, [200, 200], { demAtFix: 520 }), 558 + M),
	"inside, DEM 38 m below → floor",
);
// inside the island (hole): not inside the water; the island shore is 100 m away (> radius) → null
ok(
	lakeFloor(scene, [500, 500], { demAtFix: 556, hAccM: 14 }) === null,
	"on the island → null",
);
// (b) on land 20 m from the shore: DEM 2 m below the level → floor (shore artefact)
ok(
	near(lakeFloor(scene, [-20, 500], { demAtFix: 556, hAccM: 14 }), 558 + M),
	"shore, 2 m low → floor",
);
// … DEM 10 m below (dam / dyke between) → null
ok(
	lakeFloor(scene, [-20, 500], { demAtFix: 548, hAccM: 14 }) === null,
	"shore, 10 m low → null",
);
// … no DEM → rule (b) off
ok(
	lakeFloor(scene, [-20, 500], { hAccM: 14 }) === null,
	"shore, no DEM → null",
);
// … 60 m away with hAcc 14 (radius 44) → null; with hAcc 40 (radius 70) → floor
ok(
	lakeFloor(scene, [-60, 500], { demAtFix: 556, hAccM: 14 }) === null,
	"60 m, r 44 → null",
);
ok(
	near(lakeFloor(scene, [-60, 500], { demAtFix: 556, hAccM: 40 }), 558 + M),
	"60 m, r 70 → floor",
);
// high above the lake: the floor exists but the caller only raises when it binds
const hi = lakeFloorDetail(scene, [-20, 500], { demAtFix: 600, hAccM: 14 });
ok(
	near(hi?.floorM, 558 + M) &&
		hi?.inside === false &&
		near(hi?.distM, 20, 1e-6),
	"detail fields",
);
// reservoir skipped even when inside
ok(
	lakeFloor(scene, [500, 3500], { demAtFix: 650 }) === null,
	"reservoir skipped",
);
// explicit radius + margin
ok(
	near(
		lakeFloor(scene, [-60, 500], { demAtFix: 556, radiusM: 100, marginM: 1 }),
		559,
	),
	"opts",
);
// highest eligible lake wins
const two: SceneLake[] = [
	{ ...sA, levelM: 558 },
	{ ...sA, levelM: 560, name: "higher" },
];
ok(lakeFloorDetail(two, [200, 200])?.lake === "higher", "max over lakes");
// NaN level is ignored
ok(
	lakeFloor([{ ...sA, levelM: Number.NaN }], [200, 200]) === null,
	"NaN level ignored",
);

// ---- candidateLakes: only near lakes get a level (DEM median evaluated lazily)
let absCalls = 0;
const noEle = lakes.map((l) => ({ ...l, ele: null, name: "Nameless" }));
const cands = candidateLakes(noEle, ll(200, 200).lat, ll(200, 200).lon, {
	hAccM: 14,
	absHeight: () => {
		absCalls++;
		return 557.2;
	},
});
ok(
	cands.length === 1 && near(cands[0].levelM, 557.2),
	`one candidate with DEM level (${cands.length})`,
);
ok(absCalls > 0 && absCalls <= 600, `DEM samples bounded (${absCalls})`);

// ---- fetch: memo, failure retry, region precedence, abort, fail-open floor
async function asyncChecks() {
	_resetLakesMemo();
	let calls = 0;
	const fetchWater = async () => {
		calls++;
		return { elements: els };
	};
	const a = await lakesNear(LAT0, LON0, { fetchWater });
	const b = await lakesNear(LAT0 + 0.001, LON0, { fetchWater });
	ok(a.length === 3 && b === a && calls === 1, "memoised per cell");
	const fromRegion = await lakesNear(LAT0, LON0, {
		region: { lakes: [] },
		fetchWater,
	});
	ok(fromRegion.length === 0 && calls === 1, "region.lakes wins, no fetch");
	_resetLakesMemo();
	let n = 0;
	const flaky = async () => {
		if (n++ === 0) throw new Error("503");
		return { elements: els };
	};
	const e1 = await lakesNear(LAT0, LON0, { fetchWater: flaky }).catch(
		() => "err",
	);
	const e2 = await lakesNear(LAT0, LON0, { fetchWater: flaky });
	ok(e1 === "err" && e2.length === 3, "failed fetch forgotten, retried");
	_resetLakesMemo();
	const ctl = new AbortController();
	const slow = () => new Promise<{ elements: WaterElement[] }>(() => {});
	const p = lakesNear(LAT0, LON0, { fetchWater: slow, signal: ctl.signal });
	ctl.abort();
	ok(
		(await p.catch((e) => (e as Error).name)) === "AbortError",
		"abort rejects the caller",
	);
	// photoLakeFloor: timeout, throw → null; a real hit
	const t0 = Date.now();
	const tf = await photoLakeFloor(LAT0, LON0, {
		fetchWater: slow,
		timeoutMs: 50,
	});
	ok(tf === null && Date.now() - t0 < 1000, "timeout → null");
	_resetLakesMemo();
	const thrown = await photoLakeFloor(LAT0, LON0, {
		fetchWater: async () => {
			throw new Error("x");
		},
	});
	ok(thrown === null, "fetch error → null");
	_resetLakesMemo();
	const inLake = ll(200, 200);
	const hit = await photoLakeFloor(inLake.lat, inLake.lon, {
		fetchWater,
		hAccM: 10,
		demAtFix: 540,
	});
	ok(
		near(hit?.floorM, 558 + M) && hit?.inside === true,
		"photoLakeFloor inside hit",
	);
	const shore = ll(-20, 500);
	const dry = await photoLakeFloor(shore.lat, shore.lon, {
		fetchWater,
		hAccM: 10,
		demAtFix: 548,
	});
	ok(dry === null, "photoLakeFloor dam case → null");
}

await asyncChecks();
console.log(`lakes.check: ${fails ? `${fails} FAILED` : "all passed"}`);
process.exit(fails ? 1 : 0);
