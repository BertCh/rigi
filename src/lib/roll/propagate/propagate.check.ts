// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node checks for the R5 roll wiring (plan.ts). Run: npx tsx src/lib/roll/propagate/propagate.check.ts
// Uses public/photos/photos.json, data/ground-truth.json and the research cache in
// tools/nearfield/propagate/cache (the study's own rot estimates), so no service is needed.
import { existsSync, readFileSync } from "node:fs";
import type { Pose } from "../../camera";
import type { Mat3 } from "../../nearfield/propagate";
import type { PhotoMeta } from "../../photos";
import type { Roll, RollPhoto } from "../types";
import {
	anchorKind,
	candidatesFor,
	cycleDeg,
	isTarget,
	poseDeltaDeg,
	propose,
	type RelRotResult,
} from "./plan";

let fails = 0;
const ok = (c: boolean, msg: string) => {
	if (!c) fails++;
	console.log(c ? "ok  " : "FAIL", msg);
};

const metas = JSON.parse(
	readFileSync("public/photos/photos.json", "utf8"),
) as PhotoMeta[];
const gt = JSON.parse(readFileSync("data/ground-truth.json", "utf8")) as Record<
	string,
	{ yaw: number; pitch: number; roll: number; f: number; height: number }
>;
const ids = ["IMG_7053", "IMG_7059", "IMG_7063", "IMG_7068", "IMG_7086"];
const gtPose = (id: string): Pose => {
	const g = gt[id];
	return {
		yaw: g.yaw,
		pitch: g.pitch,
		roll: g.roll,
		vfov: (2 * Math.atan(g.height / 2 / g.f) * 180) / Math.PI,
	};
};
const rp = (id: string, src: RollPhoto["poseSource"]): RollPhoto => {
	const meta = metas.find((m) => m.id === id) as PhotoMeta;
	return {
		meta,
		pose:
			src === "prior"
				? {
						yaw: meta.heading ?? 0,
						pitch: meta.pitch,
						roll: meta.roll,
						vfov: meta.vfov,
					}
				: gtPose(id),
		poseSource: src,
		confidence: null,
		eyeAlt: null,
		t: 0,
		viewpoint: 0,
	};
};
// anchor 7063 as a user-saved pose (its GT); the rest have only their EXIF prior
const photosOn = ids.map((id) => rp(id, id === "IMG_7063" ? "saved" : "prior"));
const roll: Roll = {
	id: "t",
	name: "t",
	photos: photosOn,
	viewpoints: [],
	center: { lat: 46.71, lon: 7.77 },
	radiusM: 200,
	region: null,
};
const A = photosOn[2];

// 1. anchor / target eligibility
ok(anchorKind(A, "on", null) === "saved", "saved pose anchors");
ok(
	anchorKind(rp("IMG_7068", "solved"), "on", "cascade") === "solved",
	"aligner-solved pose anchors",
);
ok(
	anchorKind(rp("IMG_7068", "solved"), "on", "propagated-suggestion") === null,
	"an accepted propagated pose never anchors (no chaining)",
);
ok(
	anchorKind(rp("IMG_7068", "ground-truth"), "on", null) === null,
	"GT does not anchor in mode on",
);
ok(
	anchorKind(rp("IMG_7068", "ground-truth"), "dev", null) === "ground-truth",
	"GT anchors in dev",
);
ok(anchorKind(A, "off", null) === null, "off = nothing");
ok(
	!isTarget(rp("IMG_7068", "solved"), "on") &&
		isTarget(rp("IMG_7068", "prior"), "on"),
	"targets: prior only (on)",
);

// 2. candidates: baselines and the compass pre-filter
const cs = candidatesFor(roll, A, "on");
for (const c of cs)
	console.log(
		`     ${c.target.meta.id} baseline ${c.baselineM.toFixed(0)} m dt ${c.dtS.toFixed(0)} s Δcompass ${c.compassDeltaDeg?.toFixed(0)}° skip=${c.skip}`,
	);
const byId = Object.fromEntries(cs.map((c) => [c.target.meta.id, c]));
ok(
	!byId.IMG_7059.skip && !byId.IMG_7068.skip,
	"overlapping neighbours 7059/7068 go to the estimator",
);
ok(
	!!byId.IMG_7053.skip?.startsWith("compass"),
	"7053 (points ~135° away) skipped by compass in mode on",
);
ok(
	candidatesFor(roll, A, "dev").every((c) => !c.skip?.startsWith("compass")),
	"dev mode runs the estimator despite the compass",
);
const far = {
	...rp("IMG_7068", "prior"),
	meta: { ...rp("IMG_7068", "prior").meta, id: "far", lat: 46.715 },
};
ok(
	!!candidatesFor({ ...roll, photos: [...photosOn, far] }, A, "on")
		.find((c) => c.target.meta.id === "far")
		?.skip?.startsWith("baseline"),
	"a neighbour > 250 m away is skipped (baseline)",
);

// 3. propose() on the study's cached rot estimates (anchor GT pose, target EXIF vfov)
const cache = (a: string, b: string) => {
	const f = `tools/nearfield/propagate/cache/real_${a}_${b}.json`;
	if (!existsSync(f)) return null;
	const c = JSON.parse(readFileSync(f, "utf8"));
	return c;
};
const toRes = (
	c: {
		rot: { relR: number[][]; inliers: number; rmsPx: number };
		rotBwd: { relR: number[][]; inliers: number; rmsPx: number };
		matches: number;
	},
	a: RollPhoto,
	b: RollPhoto,
): RelRotResult => ({
	method: "rot",
	relR: c.rot.relR.flat(),
	inliers: c.rot.inliers,
	n: c.matches,
	rmsPx: c.rot.rmsPx,
	bwd: {
		relR: c.rotBwd.relR.flat(),
		inliers: c.rotBwd.inliers,
		rmsPx: c.rotBwd.rmsPx,
	},
	fwdBwdDeg: null,
	sizeA: [a.meta.width, a.meta.height],
	sizeB: [b.meta.width, b.meta.height],
	seconds: 0,
});
const c68 = cache("IMG_7063", "IMG_7068");
const c59 = cache("IMG_7063", "IMG_7059");
const c6859 = cache("IMG_7068", "IMG_7059");
if (!c68 || !c59 || !c6859) {
	console.log("skip: research cache missing");
} else {
	const B = photosOn[3];
	const r68 = toRes(c68, A, B);
	const p68 = propose(A, byId.IMG_7068, r68);
	const s = p68.suggestion;
	ok(
		!!s && s.gated && s.kind === "suggestion",
		`7063→7068 passes the gate as a suggestion (inl ${r68.inliers})`,
	);
	const d = s ? poseDeltaDeg(s.pose, gtPose("IMG_7068")) : 99;
	ok(
		d < 3,
		`7063→7068 suggestion within 3° of GT (${d.toFixed(2)}°; study 1.81)`,
	);
	ok(
		p68.cautions.some((x) => x.startsWith("parallax")),
		"73 m baseline carries a parallax caution",
	);
	ok(!("confidence" in (s ?? {})), "a suggestion has no confidence field");
	const cyc = cycleDeg(
		c68.rot.relR.flat() as Mat3,
		c6859.rot.relR.flat() as Mat3,
		c59.rot.relR.flat() as Mat3,
	);
	ok(
		cyc < 1.5,
		`triplet cycle 7063→7068→7059 vs 7063→7059 = ${cyc.toFixed(2)}° (study: 0.63 / 0.99 for its orderings)`,
	);
	ok(
		propose(A, byId.IMG_7068, r68, cyc).suggestion?.gated === true,
		"gated with the cycle applied",
	);
	ok(
		propose(A, byId.IMG_7068, r68, 3).suggestion?.gated === false,
		"a 3° cycle rejects",
	);
	const weak = propose(A, byId.IMG_7068, { ...r68, inliers: 11 });
	ok(
		weak.suggestion?.gated === false &&
			weak.suggestion.reasons.some((x) => x.startsWith("inliers")),
		"11 inliers rejects with a reason",
	);
	const farC = { ...byId.IMG_7068, baselineM: 300 };
	ok(
		propose(A, farC, r68).suggestion?.reasons.some((x) =>
			x.startsWith("baseline"),
		) === true,
		"300 m baseline rejects",
	);
	ok(
		propose(A, byId.IMG_7068, { ...r68, relR: null }).error != null,
		"no relR = error, no suggestion",
	);
}

console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
