// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { deckTerrainStyle } from "../../../style/deck-apply";
// Pins the lake waves: flat is the default (no define, nothing animates), the JS reference tilt is
// finite, bounded, animated and fades with range, the clock is still under webdriver, and the GLSL and
// WGSL carry the same wave table.
// Run: npx tsx src/lib/look/water/__tests__/waves.test.ts   (exits 1 on failure)
import { CLASSIC } from "../../../style/defaults";
import type { ViewStyle } from "../../../style/types";
import { waterWgsl } from "../water";
import {
	WATER_WAVES_FNS,
	WATER_WAVES_WGSL,
	WAVE_STILL_TIME,
	WAVE_TABLE,
	waterWaveSeconds,
	waterWavesAnimate,
	waterWavesOn,
	waterWaveTilt,
} from "../waves";

let bad = 0;
const check = (name: string, ok: boolean) => {
	if (!ok) bad++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
};

const setWebdriver = (webdriver: boolean) =>
	Object.defineProperty(globalThis, "navigator", {
		value: { webdriver },
		configurable: true,
	});

const lakes = (water: "flat" | "waves"): ViewStyle => ({
	...CLASSIC,
	terrain: {
		...CLASSIC.terrain,
		albedo: { mode: "alpine", water: true },
	},
	world: { ...CLASSIC.world, water },
});

check("default style has flat water", CLASSIC.world.water === "flat");
check("flat: waves off", !waterWavesOn(lakes("flat")));
check("waves + alpine water: on", waterWavesOn(lakes("waves")));
check(
	"waves without the lake shading: off",
	!waterWavesOn({ ...CLASSIC, world: { ...CLASSIC.world, water: "waves" } }),
);
check(
	"define only in the world view",
	deckTerrainStyle(lakes("waves"), "world").defines.includes(
		"LOOK_WATER_WAVES",
	) &&
		!deckTerrainStyle(lakes("waves"), "replace").defines.includes(
			"LOOK_WATER_WAVES",
		) &&
		!deckTerrainStyle(lakes("flat"), "world").defines.includes(
			"LOOK_WATER_WAVES",
		),
);

let finite = true;
let maxTilt = 0;
let moves = 0;
for (let i = 0; i < 400; i++) {
	const x = (i * 37.3) % 900;
	const y = (i * 91.7) % 700;
	const a = waterWaveTilt(x, y, 3, 200);
	const b = waterWaveTilt(x, y, 4, 200);
	if (![...a, ...b].every(Number.isFinite)) finite = false;
	maxTilt = Math.max(maxTilt, Math.hypot(a[0], a[1]));
	if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-4) moves++;
}
check("tilt finite", finite);
check(
	`tilt bounded (max ${maxTilt.toFixed(3)})`,
	maxTilt > 0.01 && maxTilt < 0.8,
);
check("tilt animates", moves > 300);
let far = 0;
for (let i = 0; i < 100; i++)
	far = Math.max(far, Math.hypot(...waterWaveTilt(i * 13, i * 7, 3, 60000)));
check(
	`fine packets fade with range (far max ${far.toFixed(3)})`,
	far < maxTilt,
);

check("no webdriver outside a browser: clock runs", waterWaveSeconds() >= 0);
setWebdriver(true);
check("webdriver: still clock", waterWaveSeconds() === WAVE_STILL_TIME);
check("webdriver: no animation", !waterWavesAnimate(lakes("waves")));
setWebdriver(false);
check("browser: animates", waterWavesAnimate(lakes("waves")));

const same = (src: string, re: RegExp) => (src.match(re) ?? []).length;
check(
	"both languages carry every wave packet",
	same(WATER_WAVES_FNS, /g \+= wvPacket/g) === WAVE_TABLE.length &&
		same(WATER_WAVES_WGSL, /g \+= ts_wv_packet/g) === WAVE_TABLE.length,
);
check(
	"flat WGSL has no wave code; waves WGSL reads the clock",
	!waterWgsl(false).includes("ts_water_wave_tilt") &&
		waterWgsl(true).includes("terrainWater.time") &&
		waterWgsl(true).includes("fn ts_water_wave_tilt"),
);

if (bad) {
	console.error(`${bad} failed`);
	process.exit(1);
}
