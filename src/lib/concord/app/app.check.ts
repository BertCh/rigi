// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Integration checks (node, synthetic): npx tsx src/lib/concord/app/app.check.ts
import type { AlignState } from "#/lib/ontology/crosswalk/pose";
import { concordFlags, parseConcordFlags } from "../flags";
import { isLowConfidence } from "./confidence";
import { runConcordDisplay } from "./display";
import { concordConfidence } from "./useConcordDisplay";

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
	if (!ok) fails++;
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
	);
}

// flags
const none = parseConcordFlags("");
check(
	"no ?concord ⇒ every flag off",
	Object.values(none).every((v) => v === false),
);
check("node (no location) ⇒ off", !concordFlags().occl && !concordFlags().eye);
const f = parseConcordFlags("?renderer=deck&concord=warp,%20occl,bogus");
check(
	"?concord=warp, occl,bogus ⇒ occl only (warp was removed)",
	f.occl && !f.eye && !("warp" in f),
);

// confidence mapping (fail closed)
const base = { pose: {}, settled: true, alignState: "auto" as AlignState };
check(
	"verified ⇒ not LOW",
	concordConfidence({ ...base, verify: "verified" }) !== null,
);
for (const v of ["unverified", "kept", "timeout", "pending", null] as const)
	check(
		`verify=${v} (auto) ⇒ LOW`,
		concordConfidence({ ...base, verify: v }) === null,
	);
check(
	"not settled ⇒ LOW even if verified",
	concordConfidence({ ...base, settled: false, verify: "verified" }) === null,
);
for (const a of ["manual", "pinned", "saved", "prior", "unverified"] as const)
	check(
		`alignState=${a} ⇒ LOW`,
		concordConfidence({ ...base, alignState: a, verify: null }) === null,
	);

// fail-closed confidence
check("null ⇒ LOW", isLowConfidence(null));
check(
	"accepted high ⇒ not LOW",
	!isLowConfidence({ accepted: true, level: "high" }),
);
check(
	"accepted:false ⇒ LOW",
	isLowConfidence({ accepted: false, level: "high" }),
);
check("level only, no confidence ⇒ LOW", isLowConfidence({ level: "high" }));

// LOW confidence: clears, computes nothing
let calls = 0;
const set: string[] = [];
const host = {
	photo: { lat: 46.7, lon: 7.8 },
	aspect: 4 / 3,
	pose: { yaw: 0, pitch: 0, roll: 0, vfov: 50 },
	eye: { x: 0, y: 0, z: 1000 },
	sampleAt: () => {
		calls++;
		return null;
	},
	readback: async () => {
		calls++;
		return true;
	},
	setOccluder: (m: unknown) => set.push(`occl:${m}`),
} as unknown as Parameters<typeof runConcordDisplay>[0];
const r = await runConcordDisplay(host, null, { occl: true });
check(
	"LOW ⇒ refused, occluder cleared, no readback / sampling",
	r.refused === "pose confidence LOW" &&
		calls === 0 &&
		set.join() === "occl:null",
	set.join(),
);
const r2 = await runConcordDisplay(
	host,
	{ accepted: true, level: "high" },
	{ occl: false },
);
check("no flags ⇒ nothing at all", !r2.occl && calls === 0 && set.length === 1);

console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
