// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { CONCEPTS } from "../catalogue/concepts";
import {
	CONFIDENCE_SCALES,
	type ConfidenceScaleId,
	compareLevel,
	confidence,
	levelOf,
} from "../core/confidence";
import {
	bboxContains,
	bboxFromSWNE,
	bboxFromWSEN,
	bboxToSWNE,
	bboxToWSEN,
} from "../core/geometry";
import {
	classifyId,
	ID_SCHEMES,
	parseUrn,
	photoKind,
	ref,
	toUrn,
} from "../core/ids";
import {
	agentOf,
	EVIDENCE,
	evidenceOf,
	isTrustedAuto,
	METHODS,
	type MethodId,
	type ProvenanceClass,
} from "../core/provenance";
import {
	PIXEL_BASES,
	type PixelBasis,
	pxPerNorm,
	rebasePx,
} from "../core/quantity";
import { RESOLUTION_POLICIES, rankUnder, resolve } from "../core/resolution";
import {
	STORAGE,
	STORAGE_PREFIXES,
	type StorageId,
	storageEntryOf,
	storageKey,
	storageKeyPattern,
} from "../core/storage";
import {
	ALIGN_STATE,
	type AlignState,
	ANCHOR_KIND,
	CANDIDATE_SOURCE,
	isPropagationAnchor,
	POSE_SOURCE,
	reachableWorkspaceStates,
	SOLVE_METHOD,
	solvedPoseProvenance,
	staleVerifyStates,
	VERDICT,
	workspaceIsSettled,
	workspaceIsTrustedAuto,
	workspaceProvenance,
} from "../crosswalk/pose";
import {
	BLEND_METHOD,
	EXPORT_KIND,
	VIEW_MODE,
} from "../crosswalk/presentation";

describe("id schemes", () => {
	it("every example matches its own scheme and no earlier scheme of the same concept", () => {
		ID_SCHEMES.forEach((s, i) => {
			expect(s.pattern.test(s.example), s.example).toBe(true);
			const earlier = ID_SCHEMES.slice(0, i).filter(
				(o) => o.concept === s.concept,
			);
			for (const o of earlier)
				expect(o.pattern.test(s.example), `${s.example} vs ${o.kind}`).toBe(
					false,
				);
			expect(classifyId(s.concept, s.example)).toBe(s.kind);
		});
	});
	it("kinds are unique within a concept", () => {
		const keys = ID_SCHEMES.map((s) => `${s.concept}/${s.kind}`);
		expect(new Set(keys).size).toBe(keys.length);
	});
	it("local-region and local-roll ids are not photos", () => {
		for (const id of [
			"local-region-46.55_7.95",
			"local-region-empty-local-3fa9c1d2e4",
			"local-roll-3fa9c1d2e4",
		]) {
			expect(classifyId("photo", id), id).toBeNull();
			expect(photoKind(id), id).toBeNull();
		}
	});
	it("classifies the real forms of each kind", () => {
		expect(classifyId("photo", "IMG_6971")).toBe("bundled");
		expect(classifyId("photo", "local-3fa9c1d2e4")).toBe("local");
		expect(classifyId("photo", "demo-03")).toBe("demo");
		expect(classifyId("photo", "wc_0042")).toBe("bench");
		expect(classifyId("region", "local-region--12.30_-100.05")).toBe("local");
		expect(classifyId("region", "demo-region")).toBe("demo");
		expect(classifyId("roll", "local-roll-3fa9c1d2e4")).toBe("local");
		expect(classifyId("dem-tile", "12/2138/1447")).toBe("slippy");
		expect(classifyId("peak", "node/1")).toBe("osm");
		expect(classifyId("lake", "relation/7")).toBe("osm");
	});
	it("rejects near misses (anchored patterns)", () => {
		expect(classifyId("photo", "xIMG_1")).toBeNull();
		expect(classifyId("photo", "IMG_1x")).toBeNull();
		expect(classifyId("photo", "local-3fa9c1d2e")).toBeNull(); // 9 hex
		expect(classifyId("photo", "local-3FA9C1D2E4")).toBeNull(); // upper case
		expect(classifyId("peak", "way/1")).toBeNull();
		expect(classifyId("dem-tile", "123/1/1")).toBeNull();
	});
	it("a bundled roll id is its region id", () => {
		expect(classifyId("roll", "region-3")).toBe("bundled");
		expect(classifyId("region", "region-3")).toBe("bundled");
	});
	it("photoKind is lenient about the hash body but strict about prefixes", () => {
		expect(photoKind("local-abc")).toBe("local");
		expect(photoKind("demo-region")).toBeNull();
		expect(photoKind("demo-7")).toBe("demo");
		expect(photoKind("random")).toBeNull();
		expect(photoKind("")).toBeNull();
	});
});

describe("URNs", () => {
	it("round trips every scheme example, including ids that contain slashes", () => {
		for (const s of ID_SCHEMES) {
			const r = ref(s.concept, s.example);
			expect(parseUrn(toUrn(r))).toEqual(r);
		}
		expect(toUrn(ref("dem-tile", "12/2138/1447"))).toBe(
			"rigi:dem-tile/12/2138/1447",
		);
	});
	it("rejects malformed urns", () => {
		for (const bad of [
			"",
			"photo/IMG_1",
			"rigi:",
			"rigi:photo",
			"rigi:photo/",
			"rigi:/IMG_1",
			"urn:photo/IMG_1",
		])
			expect(parseUrn(bad), bad).toBeNull();
	});
});

describe("confidence", () => {
	it("maps scores to levels by each scale's own thresholds", () => {
		expect(levelOf("cascade", 0.5)).toBe("high");
		expect(levelOf("cascade", 0.4999)).toBe("low");
		expect(levelOf("matcher", 0.9)).toBe("high");
		expect(levelOf("matcher", 0.2)).toBe("low");
		expect(levelOf("refine", 1)).toBe("high");
	});
	it("skyline-align is never high alone and its medium bar is strict", () => {
		expect(levelOf("skyline-align", 1)).toBe("medium");
		expect(levelOf("skyline-align", 0.2)).toBe("low");
		expect(levelOf("skyline-align", 0.2001)).toBe("medium");
	});
	it("missing or non-finite scores are unknown", () => {
		for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY])
			expect(levelOf("cascade", v)).toBe("unknown");
		expect(confidence("cascade", null)).toEqual({
			score: null,
			scale: "cascade",
			level: "unknown",
		});
		expect(confidence("cascade", 0.7)).toEqual({
			score: 0.7,
			scale: "cascade",
			level: "high",
		});
	});
	it("is monotone in the score for every scale", () => {
		const rank = { unknown: 0, low: 1, medium: 2, high: 3 } as const;
		for (const id of Object.keys(CONFIDENCE_SCALES) as ConfidenceScaleId[]) {
			let prev = 0;
			for (let s = 0; s <= 1.0001; s += 0.01) {
				const r = rank[levelOf(id, s)];
				expect(r, `${id}@${s}`).toBeGreaterThanOrEqual(prev);
				prev = r;
			}
		}
	});
	it("scale rows are coherent: medium <= high, thresholds in [0, 1]", () => {
		for (const [id, s] of Object.entries(CONFIDENCE_SCALES) as [
			string,
			(typeof CONFIDENCE_SCALES)[ConfidenceScaleId],
		][]) {
			if (s.high != null) expect(s.medium, id).toBeLessThanOrEqual(s.high);
			expect(s.medium).toBeGreaterThanOrEqual(0);
			expect(s.medium).toBeLessThanOrEqual(1);
			expect(s.calibrated, `${id} claims calibration`).toBe(false);
		}
	});
	it("compareLevel orders unknown < low < medium < high", () => {
		const order = ["unknown", "low", "medium", "high"] as const;
		for (let i = 0; i < 4; i++)
			for (let j = 0; j < 4; j++)
				expect(Math.sign(compareLevel(order[i], order[j]))).toBe(
					Math.sign(i - j),
				);
	});
});

describe("pixel bases", () => {
	const size = { width: 4000, height: 3000 };
	const portrait = { width: 3000, height: 4000 };
	it("pxPerNorm follows each basis rule", () => {
		expect(pxPerNorm("norm", size)).toBe(1);
		expect(pxPerNorm("work", size)).toBe(4000);
		expect(pxPerNorm("wide1600", portrait)).toBe(1600);
		expect(pxPerNorm("wide1000", size)).toBe(1000);
		expect(pxPerNorm("long1600", size)).toBe(1600);
		// portrait: 1600 px on the long (vertical) side means 1200 px wide
		expect(pxPerNorm("long1600", portrait)).toBe(1200);
	});
	it("rebasePx converts and round trips", () => {
		expect(rebasePx(1600, "wide1600", "norm", size)).toBe(1);
		expect(rebasePx(100, "wide1600", "wide1000", size)).toBe(62.5);
		for (const a of Object.keys(PIXEL_BASES) as PixelBasis[])
			for (const b of Object.keys(PIXEL_BASES) as PixelBasis[])
				expect(
					rebasePx(rebasePx(37.5, a, b, portrait), b, a, portrait),
				).toBeCloseTo(37.5, 9);
	});
});

describe("bbox converters", () => {
	const wsen: [number, number, number, number] = [7.1, 46.2, 8.3, 46.9];
	const swne: [number, number, number, number] = [46.2, 7.1, 46.9, 8.3];
	it("convert both orders to the same named bbox and back", () => {
		const b = bboxFromWSEN(wsen);
		expect(b).toEqual({ west: 7.1, south: 46.2, east: 8.3, north: 46.9 });
		expect(bboxFromSWNE(swne)).toEqual(b);
		expect(bboxToWSEN(b)).toEqual(wsen);
		expect(bboxToSWNE(b)).toEqual(swne);
	});
	it("bboxContains is inclusive", () => {
		const b = bboxFromWSEN(wsen);
		expect(bboxContains(b, { lat: 46.2, lon: 7.1 })).toBe(true);
		expect(bboxContains(b, { lat: 46.9, lon: 8.3 })).toBe(true);
		expect(bboxContains(b, { lat: 46.95, lon: 8 })).toBe(false);
		expect(bboxContains(b, { lat: 46.5, lon: 8.31 })).toBe(false);
	});
});

describe("storage", () => {
	const ids = Object.keys(STORAGE) as StorageId[];
	it("builds concrete keys and matches them back", () => {
		expect(storageKey("savedPose", "IMG_1")).toBe("rigi.pose.IMG_1");
		expect(storageEntryOf("rigi.pose.IMG_1")).toBe("savedPose");
		expect(storageEntryOf("rigi.rollpose.IMG_1")).toBe("solvedPose");
		expect(storageEntryOf("unregistered:key")).toBeNull();
	});
	it("a key pattern is anchored and escapes regex characters", () => {
		const re = storageKeyPattern("savedPose");
		expect(re.test("xrigi.pose.a")).toBe(false);
		expect(re.test("rigi.pose.")).toBe(false);
		expect(re.test("rigiXpose.a")).toBe(false);
	});
	it("every entry's own key resolves to a registered entry (no unreachable rows)", () => {
		for (const id of ids) {
			const concrete = STORAGE[id].key.replace(/<[^>]+>/g, "x");
			expect(storageKeyPattern(id).test(concrete), id).toBe(true);
			expect(storageEntryOf(concrete), id).not.toBeNull();
		}
	});
	it("keys are unique and storage keys use a registered prefix", () => {
		expect(new Set(ids.map((i) => STORAGE[i].key)).size).toBe(ids.length);
		for (const id of ids) {
			const e = STORAGE[id];
			if (e.medium === "localStorage")
				expect(
					STORAGE_PREFIXES.some((p) => e.key.startsWith(p)),
					`${id}: ${e.key}`,
				).toBe(true);
			if (e.version != null) expect(Number.isInteger(e.version)).toBe(true);
		}
	});
	it("versioned keys declare the same version they carry", () => {
		for (const id of ids) {
			const m = /:v(\d+)$/.exec(STORAGE[id].key);
			if (m) expect(STORAGE[id].version, id).toBe(Number(m[1]));
		}
	});
});

describe("provenance rules", () => {
	it("every method's agent and evidence are known words", () => {
		for (const [id, m] of Object.entries(METHODS)) {
			expect(m.label, id).toBeTruthy();
			for (const e of m.evidence)
				expect(EVIDENCE, `${id}: ${e}`).toHaveProperty(e);
			expect(m.estimates.length, id).toBeGreaterThan(0);
		}
	});
	it("agentOf and evidenceOf prefer explicit values over the method's", () => {
		expect(agentOf({ method: "cascade" })).toBe("solver");
		expect(agentOf({ method: "cascade", agent: "user" })).toBe("user");
		expect(agentOf({})).toBeUndefined();
		expect(evidenceOf({ method: "cascade" })).toEqual(METHODS.cascade.evidence);
		expect(evidenceOf({ method: "cascade", evidence: ["gps"] })).toEqual([
			"gps",
		]);
		expect(evidenceOf({})).toEqual([]);
	});
	it("trusted auto = accepted, not by a user, and corroborated or HIGH", () => {
		const solver: ProvenanceClass = { agent: "solver", status: "accepted" };
		expect(isTrustedAuto(solver)).toBe(false);
		expect(isTrustedAuto({ ...solver, corroborated: true })).toBe(true);
		expect(isTrustedAuto({ ...solver, level: "high" })).toBe(true);
		expect(isTrustedAuto({ ...solver, level: "medium" })).toBe(false);
		expect(isTrustedAuto({ ...solver, corroborated: false })).toBe(false);
		expect(
			isTrustedAuto({ agent: "user", status: "accepted", level: "high" }),
		).toBe(false);
		expect(
			isTrustedAuto({ agent: "user", status: "endorsed", corroborated: true }),
		).toBe(false);
		expect(
			isTrustedAuto({ agent: "solver", status: "candidate", level: "high" }),
		).toBe(false);
		// the agent can come from the method
		expect(
			isTrustedAuto({ method: "pin-solve", status: "accepted", level: "high" }),
		).toBe(false);
	});
});

describe("resolution policies", () => {
	const gt: ProvenanceClass = {
		agent: "reference",
		method: "ground-truth-fit",
		status: "accepted",
	};
	const solved: ProvenanceClass = {
		agent: "solver",
		method: "cascade",
		status: "accepted",
	};
	const saved: ProvenanceClass = { status: "endorsed" };
	const prior: ProvenanceClass = {
		agent: "sensor",
		method: "exif-prior",
		role: "prior",
		status: "candidate",
	};
	it("roll display: saved > ground truth > solved > prior", () => {
		const r = (p: ProvenanceClass) => rankUnder("rollDisplay", p);
		expect(r(saved)).toBeLessThan(r(gt));
		expect(r(gt)).toBeLessThan(r(solved));
		expect(r(solved)).toBeLessThan(r(prior));
		expect(r(prior)).toBeGreaterThanOrEqual(0);
	});
	it("evaluation never chooses ground truth or a person's pose", () => {
		expect(rankUnder("evaluation", gt)).toBe(-1);
		expect(rankUnder("evaluation", saved)).toBe(-1);
		expect(rankUnder("evaluation", solved)).toBeGreaterThanOrEqual(0);
	});
	it("an oracle-role ground truth is never displayed", () => {
		const oracle = { ...gt, role: "oracle" as const };
		for (const p of Object.keys(
			RESOLUTION_POLICIES,
		) as (keyof typeof RESOLUTION_POLICIES)[])
			expect(rankUnder(p, oracle), p).toBe(-1);
	});
	it("stateless roll ignores saved and solved poses", () => {
		expect(rankUnder("rollStateless", saved)).toBe(-1);
		expect(rankUnder("rollStateless", solved)).toBe(-1);
	});
	it("resolve picks the best rank, keeps input order on ties, and returns null with no candidate", () => {
		const items = [
			{ value: "prior", prov: prior },
			{ value: "solved-a", prov: solved },
			{ value: "solved-b", prov: solved },
			{ value: "gt", prov: gt },
		];
		expect(resolve("rollDisplay", items)?.value).toBe("gt");
		expect(resolve("evaluation", items)?.value).toBe("solved-a");
		expect(resolve("evaluation", [{ value: 1, prov: gt }])).toBeNull();
		expect(resolve("rollDisplay", [])).toBeNull();
	});
	it("workspace: verified auto beats an unverified candidate, a person's pose beats all", () => {
		const verified = workspaceProvenance("auto", "verified");
		const unverified = workspaceProvenance("unverified", null);
		expect(rankUnder("workspace", verified)).toBeLessThan(
			rankUnder("workspace", unverified),
		);
		expect(rankUnder("workspace", workspaceProvenance("manual", null))).toBe(0);
	});
});

describe("pose crosswalk", () => {
	it("every row's method (when set) is a known method and its agent differs only for endorsed rows", () => {
		const tables: Record<string, Record<string, ProvenanceClass>> = {
			POSE_SOURCE,
			SOLVE_METHOD,
			ALIGN_STATE,
			VERDICT,
			CANDIDATE_SOURCE,
			ANCHOR_KIND,
		};
		for (const [name, t] of Object.entries(tables))
			for (const [k, row] of Object.entries(t)) {
				if (!row.method) continue;
				expect(METHODS, `${name}.${k}`).toHaveProperty(row.method);
				// an explicit agent may differ from the method's only when a person endorsed it
				const methodAgent = METHODS[row.method as MethodId].agent;
				if (row.agent && row.agent !== methodAgent)
					expect(row.status, `${name}.${k}`).toBe("endorsed");
			}
	});
	it("every labelled state has a unique label and a hint", () => {
		for (const t of [POSE_SOURCE, ALIGN_STATE]) {
			const labels = Object.values(t).map((r) => r.label);
			expect(new Set(labels).size).toBe(labels.length);
			for (const r of Object.values(t))
				expect(r.hint.length).toBeGreaterThan(10);
		}
	});
	it("a person's states are endorsed, never trusted-auto", () => {
		for (const a of ["saved", "manual", "pinned"] as const) {
			expect(ALIGN_STATE[a].status).toBe("endorsed");
			expect(workspaceIsTrustedAuto(a, null)).toBe(false);
			expect(workspaceIsSettled(a, null)).toBe(true);
		}
	});
	it("a verdict on a person's pose is ignored (stale-verify bug stays fixed)", () => {
		for (const [a, v] of staleVerifyStates()) {
			expect(workspaceProvenance(a, v), `${a}/${v}`).toEqual(
				workspaceProvenance(a, null),
			);
			expect(workspaceIsTrustedAuto(a, v)).toBe(false);
		}
	});
	it("auto is trusted only once verified; refined/matched promote accepted", () => {
		expect(workspaceIsTrustedAuto("auto", null)).toBe(false);
		expect(workspaceIsTrustedAuto("auto", "pending")).toBe(false);
		expect(workspaceIsTrustedAuto("auto", "verified")).toBe(true);
		expect(workspaceIsTrustedAuto("auto", "kept")).toBe(false);
		expect(workspaceIsTrustedAuto("accepted", null)).toBe(true);
		expect(workspaceIsTrustedAuto("accepted", "refined")).toBe(true);
		expect(workspaceIsTrustedAuto("accepted", "matched")).toBe(true);
		expect(workspaceIsTrustedAuto("prior", "verified")).toBe(false);
		expect(workspaceIsTrustedAuto("near-compass", "kept")).toBe(false);
		expect(workspaceIsTrustedAuto("unverified", "unverified")).toBe(false);
	});
	it("a pending verification marks the pose pending", () => {
		expect(workspaceProvenance("auto", "pending").status).toBe("pending");
		expect(workspaceProvenance("auto", null).status).toBe("accepted");
	});
	it("a replacing verdict supplies the method, a keeping one does not", () => {
		expect(workspaceProvenance("auto", "matched").method).toBe("matcher");
		expect(workspaceProvenance("auto", "refined").method).toBe("cascade");
		expect(workspaceProvenance("auto", "kept").method).toBe("skyline-align");
	});
	it("reachable states are unique and use real align states", () => {
		const states = reachableWorkspaceStates();
		const keys = states.map(([a, v]) => `${a}/${v}`);
		expect(new Set(keys).size).toBe(keys.length);
		for (const [a] of states) expect(ALIGN_STATE).toHaveProperty(a);
		for (const a of Object.keys(ALIGN_STATE) as AlignState[])
			expect(keys).toContain(`${a}/null`);
		const stale = new Set(staleVerifyStates().map(([a, v]) => `${a}/${v}`));
		for (const k of keys.filter((k) => !k.endsWith("/null")))
			expect(stale.has(k), `${k} reachable and stale`).toBe(false);
	});
	it("solved provenance is the SOLVE_METHOD row", () => {
		expect(solvedPoseProvenance("cascade")).toBe(SOLVE_METHOD.cascade);
		expect(solvedPoseProvenance("propagated-suggestion").agent).toBe("user");
	});
	it("propagation anchors: no chaining, ground truth only in dev, off disables all", () => {
		const modes = ["off", "on", "dev"] as const;
		expect(isPropagationAnchor(POSE_SOURCE.saved, "on")).toBe(true);
		expect(isPropagationAnchor(POSE_SOURCE.solved, "on")).toBe(true);
		expect(isPropagationAnchor(POSE_SOURCE["ground-truth"], "on")).toBe(false);
		expect(isPropagationAnchor(POSE_SOURCE["ground-truth"], "dev")).toBe(true);
		expect(isPropagationAnchor(POSE_SOURCE.prior, "dev")).toBe(false);
		expect(
			isPropagationAnchor(SOLVE_METHOD["propagated-suggestion"], "dev"),
		).toBe(false);
		for (const p of Object.values(POSE_SOURCE))
			expect(isPropagationAnchor(p, modes[0])).toBe(false);
	});
});

describe("presentation crosswalk", () => {
	it("keeps the UI words the code words map to", () => {
		expect(VIEW_MODE.replace.label).toBe("Blend");
		expect(VIEW_MODE.world.label).toBe("In map");
		expect(Object.keys(BLEND_METHOD).sort()).toEqual([
			"brush",
			"lens",
			"range",
			"swipe",
		]);
	});
	it("every export kind points to a real concept", () => {
		for (const [k, row] of Object.entries(EXPORT_KIND))
			expect(CONCEPTS, k).toHaveProperty(row.concept);
	});
});
