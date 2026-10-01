// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// npx tsx src/lib/gpu/photoprep/resident.check.ts
// Node check of the photo prep's residency handle (./resident.ts, WAG W1.1) with fake devices and
// buffers (no browser, no GPU):
//  1. lazy: no read until cpu(); concurrent cpu() calls share one read; the map is memoized (one object)
//  2. cpuSync first: the CPU reference, no read; cpu() then resolves that same object; a read in
//     flight when cpuSync runs is dropped (still one object)
//  3. a failed read: onReadFailure once, the planes withdrawn (destroyed, never pinned again), the CPU
//     reference returned
//  4. pinResidentPlanes: same device → the prep's buffers (also for a shallow copy of the map, as
//     autoAlignAsync makes); another device, a lost device, a CPU-only prep, a map with other planes,
//     an unmaterialized prep → null (align uploads)
//  5. LRU: the oldest of MAX_RESIDENT + 1 preps is retired; a pinned prep's buffers survive eviction
//     until the pin is released (release is idempotent); evicted before the read → CPU reference
//  6. planes: the read map and the CPU reference agree element for element (Object.is) on a synthetic
//     photo, and either one is what the handle gives out
import { type EdgeMap, edgeMapFg, edgeMapFromPixels } from "#/lib/align";
import {
	MAX_RESIDENT,
	PhotoPrep,
	pinResidentPlanes,
	type ResidentPlanes,
	residentCount,
	retireResident,
} from "./resident";

let failures = 0;
const check = (name: string, ok: boolean, info = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? ` ${info}` : ""}`);
};

class FakeBuffer {
	destroyed = false;
	constructor(
		readonly id: string,
		readonly byteLength: number,
	) {}
	destroy() {
		if (this.destroyed) throw new Error(`${this.id} destroyed twice`);
		this.destroyed = true;
	}
}
class FakeDevice {
	isLost = false;
	constructor(readonly id: string) {}
}

// a synthetic photo: sky gradient over a ridge, a soft foreground blob
const w = 96;
const h = 64;
const d = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++)
	for (let x = 0; x < w; x++) {
		const i = (y * w + x) * 4;
		const ridge = 26 + 8 * Math.sin(x / 9) + 3 * Math.cos(x / 3.7);
		const sky = y < ridge;
		d[i] = sky ? 110 + y : 70 + ((x * 7 + y * 3) % 40);
		d[i + 1] = sky ? 150 + y : 64 + ((x * 5) % 30);
		d[i + 2] = sky ? 225 - y : 50 + ((y * 11) % 25);
		d[i + 3] = 255;
	}
const fgMask = {
	width: 24,
	height: 16,
	data: Uint8Array.from({ length: 24 * 16 }, (_, k) =>
		(k % 24) - 18 > 0 && k / 24 > 10 ? 200 : 0,
	),
};
const fg = edgeMapFg(w, h, fgMask);
const rgb = new Uint8ClampedArray(d);

let computes = 0;
const compute = () => {
	computes++;
	const m = edgeMapFromPixels(rgb, w, h, fg);
	m.rgb = rgb;
	return m;
};
const reference = compute();

let bufSeq = 0;
const planesOn = (): ResidentPlanes<FakeBuffer> => {
	const b = (id: string, n: number) =>
		new FakeBuffer(`${id}#${++bufSeq}`, n * 4);
	return {
		coarse: b("coarse", w * h),
		fine: b("fine", w * h),
		fg: b("fg", w * h),
		sky: b("sky", w * h),
		skyCum: b("skyCum", w * (h + 1)),
	};
};
const allDestroyed = (p: ResidentPlanes<FakeBuffer>) =>
	Object.values(p).every((b) => b.destroyed);
const noneDestroyed = (p: ResidentPlanes<FakeBuffer>) =>
	Object.values(p).every((b) => !b.destroyed);

/** The "GPU read": fresh arrays with the reference's bits (what the readback of exact planes gives). */
const readCopy = (): EdgeMap => ({
	w,
	h,
	coarse: Float32Array.from(reference.coarse),
	fine: Float32Array.from(reference.fine),
	sky: Float32Array.from(reference.sky),
	skyCum: Float32Array.from(reference.skyCum),
	rgb,
	fg,
});

type Gate = { open: () => void; wait: Promise<void> };
const gate = (): Gate => {
	let open = () => {};
	const wait = new Promise<void>((r) => {
		open = r;
	});
	return { open, wait };
};

function makePrep(device: FakeDevice, o: { fail?: boolean; gate?: Gate } = {}) {
	const planes = planesOn();
	const counters = { reads: 0, failures: 0, pinnedDuringRead: false };
	const prep = new PhotoPrep<FakeDevice, FakeBuffer>({
		w,
		h,
		rgb,
		fg,
		compute,
		gpu: {
			device,
			planes,
			read: async (p) => {
				counters.reads++;
				if (o.gate) await o.gate.wait;
				// the planes handed to the read are the prep's own, alive
				counters.pinnedDuringRead =
					p.coarse === planes.coarse && noneDestroyed(planes);
				if (o.fail) throw new Error("injected read failure");
				return readCopy();
			},
			onReadFailure: () => {
				counters.failures++;
			},
		},
	});
	return { prep, planes, counters };
}

const samePlanes = (a: EdgeMap, b: EdgeMap) => {
	for (const k of ["coarse", "fine", "sky", "skyCum"] as const) {
		const x = a[k];
		const y = b[k];
		if (x.length !== y.length) return `${k} length`;
		for (let i = 0; i < x.length; i++)
			if (!Object.is(x[i], y[i])) return `${k}[${i}]`;
	}
	return "";
};

// ---- 1. lazy + memoized ----
{
	const dev = new FakeDevice("A1");
	const g = gate();
	const { prep, counters } = makePrep(dev, { gate: g });
	check("no read before cpu()", counters.reads === 0 && !prep.materialized);
	const c0 = computes;
	const p1 = prep.cpu();
	const p2 = prep.cpu();
	g.open();
	const [m1, m2] = await Promise.all([p1, p2]);
	const m3 = await prep.cpu();
	check(
		"concurrent cpu() share one read, one object",
		counters.reads === 1 && m1 === m2 && m2 === m3,
		`reads ${counters.reads}`,
	);
	check("the read held a pin on live planes", counters.pinnedDuringRead);
	check(
		"read path computes nothing on the CPU",
		computes === c0 && prep.source === "gpu-read",
	);
	check("cpuSync after the read returns the memo", prep.cpuSync() === m1);
	check(
		"read map = CPU reference (Object.is)",
		samePlanes(m1, reference) === "",
	);
	check("read map carries the prep's rgb / fg", m1.rgb === rgb && m1.fg === fg);
}

// ---- 2. cpuSync first, and a read overtaken by cpuSync ----
{
	const dev = new FakeDevice("A2");
	const { prep, counters } = makePrep(dev);
	const s = prep.cpuSync();
	const a = await prep.cpu();
	check(
		"cpuSync first: CPU reference, no read, cpu() = same object",
		counters.reads === 0 && a === s && prep.source === "cpu",
	);
	check("cpuSync map = CPU reference", samePlanes(s, reference) === "");

	const dev2 = new FakeDevice("A3");
	const g = gate();
	const r = makePrep(dev2, { gate: g });
	const pending = r.prep.cpu();
	const sync = r.prep.cpuSync();
	g.open();
	const late = await pending;
	check(
		"read in flight, then cpuSync: one object (the sync one)",
		late === sync && r.counters.reads === 1 && r.prep.source === "cpu",
	);
}

// ---- 2b. cpuSync first → the GPU planes are unverified: never pinned (review W1.1 #1) ----
{
	const dev = new FakeDevice("A5");
	const { prep, planes, counters } = makePrep(dev);
	const m = prep.cpuSync();
	check(
		"GPU prep → cpuSync → pin → null, planes retired",
		pinResidentPlanes(dev, m) === null &&
			!prep.resident &&
			allDestroyed(planes) &&
			counters.reads === 0,
	);
	const dev2 = new FakeDevice("A6");
	const g = gate();
	const r = makePrep(dev2, { gate: g });
	const pending = r.prep.cpu();
	const sync = r.prep.cpuSync();
	check(
		"read in flight, cpuSync wins → no pin; planes kept until the read's pin ends",
		pinResidentPlanes(dev2, sync) === null && noneDestroyed(r.planes),
	);
	g.open();
	await pending;
	check("…then destroyed", allDestroyed(r.planes));
}

// ---- 3. a failed read ----
{
	const dev = new FakeDevice("A4");
	const { prep, planes, counters } = makePrep(dev, { fail: true });
	const m = await prep.cpu();
	check(
		"failed read: onReadFailure once, CPU reference",
		counters.failures === 1 &&
			prep.readFailures === 1 &&
			prep.source === "cpu" &&
			samePlanes(m, reference) === "",
	);
	check(
		"failed read: planes withdrawn and destroyed",
		!prep.resident && prep.released && allDestroyed(planes),
	);
	check("failed read: never pinned again", pinResidentPlanes(dev, m) === null);
	check("failed read: second cpu() same object", (await prep.cpu()) === m);
}

// ---- 4. pinResidentPlanes ----
{
	const dev = new FakeDevice("B1");
	const other = new FakeDevice("B2");
	const { prep, planes } = makePrep(dev);
	check(
		"unmaterialized prep → no pin (align has no map to look up yet)",
		pinResidentPlanes(dev, {
			coarse: new Float32Array(1),
			fine: new Float32Array(1),
			fg,
		}) === null,
	);
	const m = await prep.cpu();
	const pin = pinResidentPlanes(dev, m);
	check(
		"same device → the prep's buffers",
		pin?.coarse === planes.coarse &&
			pin?.fine === planes.fine &&
			pin?.fg === planes.fg,
	);
	pin?.release();
	const copy: EdgeMap = { ...m, sky: m.sky.slice(), skyCum: m.skyCum.slice() };
	const pc = pinResidentPlanes(dev, copy);
	check(
		"shallow copy (autoAlignAsync's own) → pinned",
		pc?.coarse === planes.coarse,
	);
	pc?.release();
	check("another device → null", pinResidentPlanes(other, m) === null);
	check(
		"a map with other fine → null",
		pinResidentPlanes(dev, { ...m, fine: m.fine.slice() }) === null,
	);
	const cpuOnly = new PhotoPrep({ w, h, rgb, fg, compute, map: compute() });
	check(
		"CPU-only prep → null",
		pinResidentPlanes(dev, cpuOnly.cpuSync()) === null &&
			!cpuOnly.resident &&
			cpuOnly.device === null,
	);
	dev.isLost = true;
	check("lost device → null", pinResidentPlanes(dev, m) === null);
}

// ---- 5. LRU eviction and pins ----
{
	const dev = new FakeDevice("C1");
	const preps = [];
	for (let i = 0; i < MAX_RESIDENT; i++) preps.push(makePrep(dev));
	const first = preps[0];
	const m0 = await first.prep.cpu();
	const pin = pinResidentPlanes(dev, m0);
	check(`${MAX_RESIDENT} preps resident`, residentCount(dev) === MAX_RESIDENT);
	const extra = makePrep(dev);
	check(
		"one more → the oldest retired",
		residentCount(dev) === MAX_RESIDENT && !first.prep.resident,
	);
	check(
		"evicted while pinned: buffers alive until release",
		!!pin && noneDestroyed(first.planes) && !first.prep.released,
	);
	check("evicted: no new pin", pinResidentPlanes(dev, m0) === null);
	pin?.release();
	pin?.release(); // idempotent
	check(
		"released → destroyed once",
		allDestroyed(first.planes) && first.prep.released,
	);
	// evicted before its first read: CPU reference, no read
	const second = preps[1];
	second.prep.retire();
	const c0 = computes;
	const m1 = await second.prep.cpu();
	check(
		"evicted before the read → CPU reference, no read",
		second.counters.reads === 0 &&
			computes === c0 + 1 &&
			samePlanes(m1, reference) === "" &&
			allDestroyed(second.planes),
	);
	second.prep.retire();
	check("retire is idempotent", allDestroyed(second.planes));
	check(
		"newest still resident",
		extra.prep.resident && noneDestroyed(extra.planes),
	);
}

// ---- 7. retireResident (the device's GPU photo prep turned off) ----
{
	const dev = new FakeDevice("D1");
	const a = makePrep(dev);
	const b = makePrep(dev);
	const other = makePrep(new FakeDevice("D2"));
	retireResident(dev);
	check(
		"retireResident: every prep of the device retired, others kept",
		residentCount(dev) === 0 &&
			allDestroyed(a.planes) &&
			allDestroyed(b.planes) &&
			other.prep.resident,
	);
	const m = await a.prep.cpu();
	check(
		"retired prep reads the CPU reference",
		a.counters.reads === 0 && samePlanes(m, reference) === "",
	);
}

console.log(failures ? `\n${failures} FAILED` : "\nall ok");
process.exit(failures ? 1 : 0);
