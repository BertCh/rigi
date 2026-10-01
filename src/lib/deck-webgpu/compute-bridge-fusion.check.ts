// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node check for the settle-fusion bookkeeping of compute-bridge.ts (WAG W1.2), no GPU: a fake
// device whose textures are plain objects. The GPU side (the prepared pass's bytes equal the
// separate pass's) is scripts/deck-webgpu/settle-submits.mjs, in a browser.
//   npx tsx src/lib/deck-webgpu/compute-bridge-fusion.check.ts
// Checks:
//   1. the mask output pool never hands out the shown or the prepared texture, skips textures a
//      queued pass still writes when asked to (a prepared write), and stops at its cap;
//   2. updateMasks adopts a prepared pass only when every input matches (render seq, geometry
//      texture, photo, people, P(sky) as the style uses it, grid, no blend cut); any mismatch
//      leaves the prepared pass alone and takes the separate pass;
//   3. adoption publishes the prepared texture with the call's generation, drops older queued
//      results (maskSeq), fires onAsync once, and the same inputs again are a no-op;
//   4. reset() and a new prepare drop a pending prepared pass;
//   5. settleFusion off (fusionOn false): nothing is prepared or adopted, a pending prepared pass
//      is dropped, and the separate pass writes the original ping-pong slot (flip ^ 1).
import type { Device, Texture } from "@luma.gl/core";
import type { Mask8 } from "#/lib/look/composite";
import { gridSize, MASK_LONG_SIDE } from "#/lib/look/composite";
import { presetStyle } from "#/lib/style/presets";
import type { ViewStyle } from "#/lib/style/types";
import { LookBridge } from "./compute-bridge";

const failures: string[] = [];
const expect = (ok: boolean, what: string) => {
	if (!ok) failures.push(what);
};

type FakeTex = {
	id: string;
	width: number;
	height: number;
	destroyed: boolean;
};
let made = 0;
const device = {
	type: "webgpu",
	isLost: false,
	createTexture: (p: { id: string; width: number; height: number }) => {
		made++;
		const t: FakeTex & { destroy: () => void } = {
			id: p.id,
			width: p.width,
			height: p.height,
			destroyed: false,
			destroy: () => {
				t.destroyed = true;
			},
		};
		return t;
	},
} as unknown as Device;

type Internals = {
	outs: (Texture | null)[];
	writing: number[];
	shown: number;
	prepared: {
		seq: number;
		geometry: Texture;
		img: HTMLImageElement;
		fg: Mask8 | null;
		sky: Mask8 | null;
		w: number;
		h: number;
		slot: number;
		texture: Texture;
		cpuMs: number;
	} | null;
	maskSeq: number;
	pickOut: (idle: boolean) => number;
	outTexture: (i: number, w: number, h: number) => Texture;
};
const inside = (b: LookBridge) => b as unknown as Internals;

// ── 1. pool
{
	const b = new LookBridge(device);
	const x = inside(b);
	expect(x.pickOut(true) === 0, "empty pool: first index is 0");
	for (let i = 0; i < 4; i++) x.outTexture(i, 8, 8);
	x.shown = 0;
	const stub = { slot: 1 } as NonNullable<Internals["prepared"]>;
	x.prepared = stub;
	x.writing = [0, 0, 1, 0];
	expect(x.pickOut(true) === 3, "idle pick skips shown, prepared and written");
	expect(x.pickOut(false) === 3, "separate-pass pick prefers an idle one too");
	x.writing = [0, 0, 1, 1];
	expect(x.pickOut(true) === -1, "idle pick at the cap with all busy is -1");
	expect(x.pickOut(false) === 2, "separate pass may share a written one");
	for (let k = 0; k < 50; k++) {
		const shown = k % 4;
		const prep = (k * 3 + 1) % 4;
		x.shown = shown;
		x.prepared = prep === shown ? null : { ...stub, slot: prep };
		x.writing = [k & 1, (k >> 1) & 1, (k >> 2) & 1, 0];
		for (const idle of [true, false]) {
			const i = x.pickOut(idle);
			if (i < 0) continue;
			expect(i !== shown, `pick ${k}: never the shown texture`);
			expect(i !== x.prepared?.slot, `pick ${k}: never the prepared one`);
			if (idle) expect(!x.writing[i], `pick ${k}: idle pick is not written`);
		}
	}
}

// ── 2./3. adoption
const style: ViewStyle = presetStyle("photo-matched");
const skyStyle = style.composite.sky === "photo";
const geometry = device.createTexture({
	id: "geo",
	width: 1024,
	height: 683,
} as never) as unknown as Texture;
const [w, h] = gridSize(1024 / 683, MASK_LONG_SIDE);
const img = {} as HTMLImageElement;
const fg = { width: 4, height: 4, data: new Uint8Array(16) } as Mask8;
const sky = { width: 4, height: 4, data: new Uint8Array(16) } as Mask8;

function bridgeWithPrepared() {
	const b = new LookBridge(device);
	const x = inside(b);
	const texture = x.outTexture(0, w, h);
	x.prepared = {
		seq: 7,
		geometry,
		img,
		fg,
		sky: skyStyle ? sky : null,
		w,
		h,
		slot: 0,
		texture,
		cpuMs: 1,
	};
	return { b, x, texture };
}

type Call = Parameters<LookBridge["updateMasks"]>[0];
const call: Call = {
	style,
	gen: 3,
	img,
	fg,
	sky,
	cut: null,
	geometry,
	geometrySeq: 7,
	range: () => ({ w: 1, h: 1, at: () => 0 }),
};

{
	const { b, x, texture } = bridgeWithPrepared();
	let fired = 0;
	b.onAsync = () => fired++;
	const seq0 = x.maskSeq;
	const ok = b.updateMasks(call);
	expect(ok, "matching inputs: updateMasks reports a pass");
	expect(
		b.masks?.texture === texture,
		"matching inputs: the prepared texture is shown",
	);
	expect(b.masks?.gen === 3, "adopted masks carry the call's generation");
	expect(b.masks?.cut === "", "adopted masks have no cut");
	expect(
		x.shown === 0 && x.prepared === null,
		"adopted: shown = its slot, nothing pending",
	);
	expect(
		x.maskSeq === seq0 + 1,
		"adoption bumps maskSeq (older queued passes drop)",
	);
	expect(b.fused.masksAdopted === 1, "adoption counted");
	expect(!b.updateMasks(call), "same inputs again: no pass");
	await Promise.resolve();
	expect(fired === 1, `onAsync fired once (got ${fired})`);
}

const mismatches: [string, Partial<Call>][] = [
	["render seq", { geometrySeq: 8 }],
	["no render seq", { geometrySeq: undefined }],
	["geometry texture", { geometry: { ...geometry } as Texture }],
	["photo", { img: {} as HTMLImageElement }],
	["people", { fg: null }],
	["blend cut", { cut: { key: "range:8", at: () => 0 } }],
];
if (skyStyle) mismatches.push(["P(sky)", { sky: null }]);
for (const [what, change] of mismatches) {
	const { b, x, texture } = bridgeWithPrepared();
	try {
		// the separate pass needs a canvas / real device here: it throws, which is fine
		b.updateMasks({ ...call, ...change });
	} catch {}
	expect(b.masks === null, `${what} differs: nothing adopted`);
	expect(
		x.prepared?.texture === texture,
		`${what} differs: prepared pass kept`,
	);
	expect(b.fused.masksAdopted === 0, `${what} differs: not counted`);
}

// ── 5. fusion off
{
	const { b, x } = bridgeWithPrepared();
	b.fusionOn = () => false;
	try {
		b.updateMasks(call);
	} catch {}
	expect(
		b.masks === null,
		"fusion off: a matching prepared pass is not adopted",
	);
	expect(x.prepared === null, "fusion off: the prepared pass is dropped");
	const r = b.prepareMasks({
		seq: 9,
		style,
		img,
		fg,
		sky,
		geometry,
		encoder: {} as never,
	});
	expect(r === null && x.prepared === null, "fusion off: nothing prepared");
}
for (const [shown, want] of [
	[-1, 1],
	[1, 0],
	[0, 1],
] as const) {
	const b = new LookBridge(device);
	const x = inside(b);
	b.fusionOn = () => false;
	x.shown = shown;
	try {
		// the separate pass picks and creates its target before the photo upload throws here
		b.updateMasks({ ...call, gen: 10 + shown });
	} catch {}
	const madeAt = x.outs.findIndex((t) => !!t);
	expect(
		madeAt === want && x.outs.filter((t) => !!t).length === 1,
		`fusion off, shown ${shown}: ping-pong writes slot ${want} (got ${madeAt})`,
	);
}

// ── 4. dropping a pending prepared pass
{
	const { b, x } = bridgeWithPrepared();
	b.reset();
	expect(x.prepared === null, "reset() drops the prepared pass");
}
{
	const { b, x } = bridgeWithPrepared();
	// refine off: prepareMasks records nothing and drops the old one
	const off = {
		...style,
		composite: { ...style.composite, refine: false },
	} as ViewStyle;
	const r = b.prepareMasks({
		seq: 8,
		style: off,
		img,
		fg,
		sky,
		geometry,
		encoder: {} as never,
	});
	expect(
		!r && x.prepared === null,
		"a new prepare drops the old prepared pass",
	);
}

const ok = failures.length === 0;
console.log(JSON.stringify({ ok, failures, texturesMade: made }));
if (!ok) process.exit(1);
