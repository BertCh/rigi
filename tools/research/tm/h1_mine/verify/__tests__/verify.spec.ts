// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildSessionOrder,
	type KeyFile,
	type KeyItem,
	mergeFiles,
	mergeVerdicts,
	normaliseVerdict,
	type PoolRecord,
	scoreVerdicts,
	seededShuffle,
	type VerdictsFile,
	validateVerdictsFile,
} from "../lib";
import { checkPack, crossCheckKey, type PackIndex } from "../pack";
import { renderSessionHtml } from "../session";

const pose = { yaw: 10, pitch: 1, roll: 0, vfov: 30 };
const eye = { lat: 46.8, lon: 8.2, h: 900 };
const ki = (
	kind: KeyItem["kind"],
	folder: string,
	extra: Partial<KeyItem> = {},
): KeyItem => ({ pid: "wc_0001", kind, pose, eye, folder, ...extra });

// Synthetic fixture: 2 folders; blind cands c1 (+dup), c2, c3, c4; control, decoy, construct-check.
const key: KeyFile = {
	candidates: {
		AA2: ki("candidate", "pAAA", { cid: "c1" }),
		AB2: ki("duplicate", "pAAA", { cid: "c1" }),
		AC2: ki("candidate", "pAAA", { cid: "c2" }),
		BA3: ki("candidate", "pBBB", { cid: "c3" }),
		BB3: ki("candidate", "pBBB", { cid: "c4" }),
		BC3: ki("positive-control", "pBBB", { ref: "A" }),
		BD3: ki("decoy-yaw+5", "pBBB", { ref: "A" }),
		AD2: ki("construct-check", "pAAA", { cid: "k1" }),
	},
};
const pool: PoolRecord[] = [
	{ pid: "wc_0002", cid: "k1", status: "wrong-construct", pose, eye },
	{ pid: "wc_0002", cid: "k2", status: "wrong-construct", pose, eye },
	{
		pid: "wc_0003",
		cid: "i1",
		status: "inherited",
		inherit: { verdict: "wrong" },
		pose,
		eye,
	},
	{
		pid: "wc_0003",
		cid: "i2",
		status: "inherited",
		inherit: { verdict: "correct" },
		pose,
		eye,
	},
	{
		pid: "wc_0003",
		cid: "i3",
		status: "inherited",
		inherit: { verdict: "conflict" },
		pose,
		eye,
	},
	{ pid: "wc_0004", cid: "cap", status: "capped", pose, eye },
];
function vf(
	verifier: string,
	m: Record<string, Record<string, string>>,
): VerdictsFile {
	const verdicts: VerdictsFile["verdicts"] = {};
	for (const [folder, items] of Object.entries(m)) {
		verdicts[folder] = {};
		for (const [l, v] of Object.entries(items))
			verdicts[folder][l] = { verdict: v as never };
	}
	return {
		schema: "h1-verdicts/1",
		verifier,
		batch: 0,
		startedAt: "t0",
		savedAt: "t1",
		verdicts,
	};
}
const va = vf("va", {
	pAAA: { AA2: "wrong", AB2: "near-miss", AC2: "correct", AD2: "wrong" },
	pBBB: { BA3: "unsure", BB3: "wrong", BC3: "correct", BD3: "wrong" },
});
const vb = vf("vb", {
	pAAA: { AA2: "wrong", AB2: "wrong", AC2: "correct", AD2: "wrong" },
	pBBB: { BA3: "correct", BB3: "correct", BC3: "correct", BD3: "correct" },
});

describe("verdict vocabulary", () => {
	it("scores near-miss as wrong and not-seen as unsure", () => {
		expect(normaliseVerdict("near-miss")).toBe("wrong");
		expect(normaliseVerdict("not-seen")).toBe("unsure");
		expect(normaliseVerdict("correct")).toBe("correct");
	});
	it("validates files", () => {
		expect(() => validateVerdictsFile({ schema: "x" })).toThrow(/schema/);
		expect(() => validateVerdictsFile({ ...va, verifier: "" })).toThrow(
			/verifier/,
		);
		expect(() => validateVerdictsFile(vf("v", { f: { A: "maybe" } }))).toThrow(
			/bad verdict/,
		);
		expect(validateVerdictsFile(va).verifier).toBe("va");
	});
});

describe("merge", () => {
	it("protocol rule: correct iff both; wrong if either", () => {
		expect(mergeVerdicts(["correct", "correct"])).toBe("correct");
		expect(mergeVerdicts(["correct", "wrong"])).toBe("wrong");
		expect(mergeVerdicts(["correct", "unsure"])).toBe("unsure");
		expect(mergeVerdicts(["wrong", "unsure"])).toBe("wrong");
	});
	it("strict rule: disagreement is unsure", () => {
		expect(mergeVerdicts(["correct", "wrong"], "strict")).toBe("unsure");
		expect(mergeVerdicts(["wrong", "wrong"], "strict")).toBe("wrong");
	});
	it("merges files and flags single-verifier labels; rejects duplicate ids", () => {
		const m = mergeFiles([va, vb]);
		expect(m.labels.BA3.verdict).toBe("unsure");
		expect(m.labels.BB3.verdict).toBe("wrong");
		expect(m.labels.AA2.singleVerifier).toBe(false);
		expect(mergeFiles([va]).labels.AA2.singleVerifier).toBe(true);
		expect(() => mergeFiles([va, va])).toThrow(/overlap/);
		// per-batch files of one verifier are unioned
		const b0 = vf("va", { pAAA: { AA2: "wrong" } });
		const b1 = vf("va", { pBBB: { BA3: "correct" } });
		expect(Object.keys(mergeFiles([b0, b1]).labels).sort()).toEqual([
			"AA2",
			"BA3",
		]);
		expect(mergeFiles([b0, b1]).verifiers).toEqual(["va"]);
	});
});

describe("scoreVerdicts on the synthetic fixture", () => {
	const r = scoreVerdicts([va, vb], key, pool);
	it("splits hard negatives 3 ways", () => {
		// c1: va dup disagrees (wrong vs near-miss->wrong agree => wrong), vb wrong -> blind wrong
		// c4: va wrong, vb correct -> protocol wrong; c3 unsure; c2 correct
		expect(r.counts.blindWrong).toBe(2);
		expect(r.counts.wrongConstruct).toBe(2);
		expect(r.counts.inheritedWrong).toBe(1);
		expect(r.counts.hardNegativesTotal).toBe(5);
		expect(r.hardNegatives.map((h) => h.source).sort()).toEqual([
			"blind-wrong",
			"blind-wrong",
			"inherited-wrong",
			"wrong-construct",
			"wrong-construct",
		]);
	});
	it("collects verified-correct poses", () => {
		expect(r.counts.blindCorrect).toBe(1);
		expect(r.counts.inheritedCorrect).toBe(1);
		expect(r.counts.positiveControls).toBe(1);
		expect(r.counts.blindUnsure).toBe(1);
	});
	it("flags a verifier that accepts a decoy and tracks the construct check", () => {
		expect(r.qc.decoyAccepted).toEqual([{ verifier: "vb", label: "BD3" }]);
		expect(r.qc.flaggedVerifiers).toEqual(["vb"]);
		expect(r.qc.constructCheck).toMatchObject({ packed: 1, agreedWrong: 1 });
	});
	it("duplicate disagreement within a verifier makes that verifier unsure", () => {
		const a = vf("va", {
			pAAA: { AA2: "correct", AB2: "wrong", AC2: "correct" },
		});
		const b = vf("vb", {
			pAAA: { AA2: "correct", AB2: "correct", AC2: "correct" },
		});
		const s = scoreVerdicts([a, b], key, []);
		expect(s.qc.duplicateDisagreements).toEqual([
			{ verifier: "va", cid: "c1" },
		]);
		// va unsure + vb correct -> unsure under protocol, so c1 is neither wrong nor correct
		expect(s.hardNegatives.find((h) => h.cid === "c1")).toBeUndefined();
		expect(s.verifiedCorrect.find((h) => h.cid === "c1")).toBeUndefined();
		expect(s.counts.blindMissing).toBe(2);
	});
	it("strict rule yields fewer blind wrongs", () => {
		const s = scoreVerdicts([va, vb], key, pool, "strict");
		expect(s.counts.blindWrong).toBe(1);
	});
});

describe("ordering", () => {
	const folders = { pA: ["AA1", "AB2", "AC3"], pB: ["BA1", "BB2"] };
	it("is deterministic per verifier, differs across verifiers, keeps folders adjacent", () => {
		const a1 = buildSessionOrder(folders, "va", ["pA", "pB"]);
		const a2 = buildSessionOrder(folders, "va", ["pA", "pB"]);
		expect(a1).toEqual(a2);
		expect(a1).toHaveLength(5);
		const seq = a1.map((x) => x.folder).join("");
		expect(seq === "pApApApBpB" || seq === "pBpBpApApA").toBe(true);
		expect(seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], "s")).not.toEqual(
			seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], "t"),
		);
	});
	it("session html embeds no key-ish fields", () => {
		const items = buildSessionOrder(folders, "va", ["pA"]);
		const html = renderSessionHtml({
			verifier: "va",
			batch: 0,
			items,
			packUrl: "../../pack/",
		});
		expect(html).toContain("candidate_AA1.jpg");
		expect(html).not.toMatch(/yaw|pitch|"pid"|cid|source/);
	});
});

describe("checkPack", () => {
	function mk(files: Record<string, string[]>) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h1pack-"));
		for (const [f, names] of Object.entries(files)) {
			fs.mkdirSync(path.join(dir, f));
			for (const n of names) fs.writeFileSync(path.join(dir, f, n), "x");
		}
		return dir;
	}
	const index: PackIndex = {
		folders: ["pA", "pB"],
		nFolders: 2,
		nImages: 3,
		suggestedBatches: [["pA"], ["pB"]],
	};
	it("passes a consistent pack", () => {
		const dir = mk({
			pA: ["photo.jpg", "candidate_AA1.jpg", "candidate_AB2.jpg"],
			pB: ["photo.jpg", "candidate_BA1.jpg"],
		});
		const r = checkPack(dir, index, { folders: 2, overlays: 3 });
		expect(r.problems).toEqual([]);
		expect(
			crossCheckKey(r, {
				candidates: {
					AA1: ki("candidate", "pA"),
					AB2: ki("candidate", "pA"),
					BA1: ki("candidate", "pB"),
				},
			}),
		).toEqual([]);
		expect(
			crossCheckKey(r, { candidates: { ZZ9: ki("candidate", "pA") } }).length,
		).toBe(4);
	});
	it("reports missing files, count mismatches and strays", () => {
		const dir = mk({
			pA: ["photo.jpg", "candidate_AA1.jpg", "notes.txt"],
			pC: ["photo.jpg", "candidate_CC1.jpg"],
		});
		const r = checkPack(dir, index);
		expect(r.ok).toBe(false);
		const p = r.problems.join("\n");
		expect(p).toMatch(/index folder missing on disk: pB/);
		expect(p).toMatch(/not in index: pC/);
		expect(p).toMatch(/nImages 3 != overlays on disk 2/);
		expect(p).toMatch(/unexpected file pA\/notes.txt/);
	});
});
