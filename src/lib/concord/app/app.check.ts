// Integration checks (node, synthetic): npx tsx src/lib/concord/app/app.check.ts
import type { MatchedCue } from "../cues";
import { concordFlags, parseConcordFlags } from "../flags";
import { runConcordDisplay, toFieldCues } from "./display";
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
check("node (no location) ⇒ off", !concordFlags().warp && !concordFlags().eye);
const f = parseConcordFlags("?renderer=deck&concord=warp,%20occl,bogus");
check("?concord=warp, occl,bogus ⇒ warp+occl only", f.warp && f.occl && !f.eye);

// confidence mapping (fail closed)
const base = { pose: {}, settled: true, alignState: "auto" };
check(
	"verified ⇒ not LOW",
	concordConfidence({ ...base, verify: "verified" }) !== null,
);
for (const v of ["unverified", "kept", "timeout", "pending", null])
	check(
		`verify=${v} (auto) ⇒ LOW`,
		concordConfidence({ ...base, verify: v }) === null,
	);
check(
	"not settled ⇒ LOW even if verified",
	concordConfidence({ ...base, settled: false, verify: "verified" }) === null,
);
for (const a of ["manual", "pinned", "saved", "prior", "unverified"])
	check(
		`alignState=${a} ⇒ LOW`,
		concordConfidence({ ...base, alignState: a, verify: null }) === null,
	);

// WP-C edge cue (predicted u,v) → WP-E field cue (observed u,v)
const edge: MatchedCue = {
	kind: "edge",
	u: 0.5,
	v: 0.5,
	nu: 0,
	nv: 1,
	world: [0, 0, 0],
	depthM: 1000,
	sigmaPx: 1,
	source: "t",
	residualPx: 3,
	conf: 1,
};
const [fc] = toFieldCues([edge], 4 / 3);
check(
	"edge cue moved to observed position (−3 px along n, @1600)",
	Math.abs(fc.u - 0.5) < 1e-12 && Math.abs((0.5 - fc.v) * 1200 - 3) < 1e-9,
	`v ${fc.v}`,
);

// LOW confidence: clears, computes nothing
let calls = 0;
const set: string[] = [];
const host = {
	photo: { lat: 46.7, lon: 7.8 },
	aspect: 4 / 3,
	pose: { yaw: 0, pitch: 0, roll: 0, vfov: 50 },
	eye: { x: 0, y: 0, z: 1000 },
	photoElement: undefined,
	sampleAt: () => {
		calls++;
		return null;
	},
	isForeground: () => false,
	readback: async () => {
		calls++;
		return true;
	},
	setWarp: (w: unknown) => set.push(`warp:${w}`),
	setOccluder: (m: unknown) => set.push(`occl:${m}`),
} as unknown as Parameters<typeof runConcordDisplay>[0];
const r = await runConcordDisplay(host, null, { warp: true, occl: true });
check(
	"LOW ⇒ refused, both cleared, no readback / sampling",
	r.refused === "pose confidence LOW" &&
		calls === 0 &&
		set.join() === "warp:null,occl:null",
	set.join(),
);
const r2 = await runConcordDisplay(
	host,
	{ accepted: true, level: "high" },
	{ warp: false, occl: false },
);
check(
	"no flags ⇒ nothing at all",
	!r2.warp && !r2.occl && calls === 0 && set.length === 2,
);

console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
