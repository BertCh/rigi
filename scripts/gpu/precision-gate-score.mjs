// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The precision gate's scoring (scripts/gpu/precision-gate.mjs), pure and node-testable
// (scripts/gpu/precision-gate.check.mjs): the identity arm (every mode of one photo ran on the same
// page and terrain: base vs base2 = the f64 noise floor, base vs cand), the quality arm (each mode's
// accepts against the wild set's blind verdicts) and the verdict.
import fs from "node:fs";
import path from "node:path";

const POSE = ["yaw", "pitch", "roll", "vfov"];

export const samePose = (a, b) =>
	(a == null && b == null) ||
	(a != null && b != null && POSE.every((k) => Object.is(a[k], b[k])));

/** One seed's raw autoAlign result, bit for bit (pose, score, confidence, every alternative). */
export const sameRun = (a, b) =>
	samePose(a.pose, b.pose) &&
	Object.is(a.score, b.score) &&
	Object.is(a.confidence, b.confidence) &&
	(a.alternatives ?? []).length === (b.alternatives ?? []).length &&
	(a.alternatives ?? []).every(
		(x, i) =>
			samePose(x.pose, b.alternatives[i].pose) &&
			Object.is(x.score, b.alternatives[i].score) &&
			Object.is(x.total, b.alternatives[i].total) &&
			Object.is(x.sil, b.alternatives[i].sil),
	);

/** What differs between two modes' decisions of one photo (empty = identical). */
export function diffModes(a, b) {
	const out = [];
	if (a.accepted !== b.accepted || a.acceptKind !== b.acceptKind)
		out.push("decision");
	for (const [k, x, y] of [
		["pose", a.pose, b.pose],
		["shownPose", a.shownPose, b.shownPose],
		["native.pose", a.native?.pose, b.native?.pose],
	])
		if (!samePose(x, y)) out.push(k);
	if (!Object.is(a.confidence, b.confidence)) out.push("confidence");
	const ra = a.runs ?? [];
	const rb = b.runs ?? [];
	const seeds =
		ra.length !== rb.length
			? -1
			: ra.filter((x, i) => !sameRun(x, rb[i])).length;
	if (seeds !== 0) out.push(seeds < 0 ? "seed count" : `${seeds} seeds`);
	return out;
}

/** Angular difference in degrees, wrapped to [0, 180]. */
const dAng = (a, b) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

/**
 * Pose tolerance of "the same answer as a verified pose": well inside what a skyline overlay shows
 * (a verifier cannot tell 0.5° apart on a tele photo either way, and the verified clusters are
 * further apart than this).
 */
export const VERIFY_TOL = { yaw: 0.5, pitch: 0.5, roll: 1, vfovRel: 0.03 };

export function nearPose(a, b, tol = VERIFY_TOL) {
	return (
		dAng(a.yaw, b.yaw) <= tol.yaw &&
		Math.abs(a.pitch - b.pitch) <= tol.pitch &&
		Math.abs(a.roll - b.roll) <= tol.roll &&
		Math.abs(a.vfov - b.vfov) <= tol.vfovRel * Math.max(a.vfov, b.vfov)
	);
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const tryJson = (f) => {
	try {
		return readJson(f);
	} catch {
		return null;
	}
};

/**
 * Every blind-verified pose of the wild set: [{photo, pose, verdict, source}], verdict correct /
 * wrong / unsure. Sources (all read-only, tracked): tools/bench/gt/wild verify_v2 (two verifiers
 * per photo merged as score_wild.py does: agreement keeps the verdict, else unsure; part_4b
 * replaces part_4), tools/bench/t5/verify_v2, tools/bench/gt/final/verify (decoys included: a decoy
 * judged wrong is a wrong pose like any other).
 */
export function loadVerifiedPoses(root) {
	const out = [];
	const bench = path.join(root, "tools/bench");
	// gt/wild v2
	const keyV2 = tryJson(path.join(bench, "gt/wild/verify_v2/key_v2.json"));
	if (keyV2) {
		const key = keyV2.photos ?? keyV2;
		const dir = path.join(bench, "gt/wild/verdicts_v2");
		const parts = {};
		for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : [])
			if (/^part_.*\.json$/.test(f)) {
				const v = readJson(path.join(dir, f));
				parts[String(v.verifier)] = v.photos;
			}
		const recheck = parts["4b"] ?? {};
		delete parts["4b"];
		for (const pid of Object.keys(recheck)) delete parts["4"]?.[pid];
		const byPhoto = {};
		for (const photos of [...Object.values(parts), recheck])
			for (const [pid, e] of Object.entries(photos))
				byPhoto[pid] = [...(byPhoto[pid] ?? []), e];
		for (const [pid, entries] of Object.entries(byPhoto)) {
			const clusters = key[pid]?.clusters ?? {};
			for (const [c, ce] of Object.entries(clusters)) {
				const vs = entries
					.map((e) => e.candidates?.[c]?.verdict)
					.filter(Boolean);
				if (!vs.length || !ce.pose) continue;
				out.push({
					photo: pid,
					pose: ce.pose,
					verdict: new Set(vs).size === 1 ? vs[0] : "unsure",
					source: `gt/wild/v2:${c}`,
				});
			}
		}
	}
	// t5 v2
	const t5Key = tryJson(path.join(bench, "t5/verify_v2/key.json"));
	const t5V = tryJson(path.join(bench, "t5/verify_v2/verdicts.json"));
	if (t5Key && t5V)
		for (const [pid, e] of Object.entries(t5V.photos ?? {}))
			for (const [c, ce] of Object.entries(e.candidates ?? {})) {
				const pose = t5Key[pid]?.candidates?.[c]?.pose;
				if (pose && ce.verdict)
					out.push({
						photo: pid,
						pose,
						verdict: ce.verdict,
						source: `t5/v2:${c}`,
					});
			}
	// final (tokens)
	const fKey = tryJson(path.join(bench, "gt/final/verify/key.json"));
	const fDir = path.join(bench, "gt/final/verify/verdicts");
	if (fKey && fs.existsSync(fDir)) {
		const byToken = {};
		for (const f of fs.readdirSync(fDir))
			if (/^part_.*\.json$/.test(f))
				for (const [t, v] of Object.entries(
					readJson(path.join(fDir, f)).candidates ?? {},
				))
					byToken[t] = [...(byToken[t] ?? []), v.verdict];
		for (const [t, vs] of Object.entries(byToken)) {
			const k = fKey[t];
			if (!k?.pose || !k.pid) continue;
			out.push({
				photo: k.pid,
				pose: k.pose,
				verdict: new Set(vs).size === 1 ? vs[0] : "unsure",
				source: `gt/final:${t}`,
			});
		}
	}
	return out;
}

/**
 * The blind verdict of `pose` on `photo`: correct / wrong / unsure from the verified poses within
 * VERIFY_TOL (conflicting verdicts → unsure), "unverified" when none is that close.
 */
export function verdictOf(verified, photo, pose) {
	if (!pose) return "no-pose";
	const near = verified.filter(
		(v) => v.photo === photo && nearPose(v.pose, pose),
	);
	if (!near.length) return "unverified";
	const vs = new Set(near.map((v) => v.verdict));
	return vs.size === 1 ? [...vs][0] : "unsure";
}

/**
 * One photo's row: the identity arm and each mode's accept quality. `modes` = the harness row's
 * modes ({base, cand, base2?}: decision, poses, raw runs, all on one page and terrain).
 */
export function scorePhoto(id, modes, verified) {
	const row = { id, issues: [] };
	const { base, cand, base2 } = modes;
	row.noise = base2 ? diffModes(base, base2) : null;
	row.diff = diffModes(base, cand);
	row.quality = {};
	for (const [m, r] of Object.entries(modes))
		row.quality[m] = {
			accepted: !!r.accepted,
			kind: r.acceptKind,
			// what the app shows (shownPose: the accepted pose, or the prior when rejected) is what the
			// user judges; only accepted poses count as answers
			verdict: r.accepted
				? verdictOf(verified, id, r.shownPose ?? r.pose)
				: null,
		};
	const qb = row.quality.base;
	const qc = row.quality.cand;
	const q2 = row.quality.base2 ?? null;
	row.newAccept = !qb.accepted && qc.accepted;
	row.lostAccept = qb.accepted && !qc.accepted;
	// cand shows an accepted pose f64 did not show (a new accept, or another pose than base's)
	const shown = (r) => (r?.accepted ? (r.shownPose ?? r.pose) : null);
	const sameShown = (x, y) => !!x && !!y && nearPose(x, y);
	row.changedAccept =
		qc.accepted &&
		!sameShown(shown(cand), shown(base)) &&
		!sameShown(shown(cand), shown(base2));
	// per photo, with the f64 noise floor: f64 itself (base or base2) giving the same verdict is not cand's
	row.falseAccept =
		qc.verdict === "wrong" && qb.verdict !== "wrong" && q2?.verdict !== "wrong";
	row.lostCorrect =
		qb.verdict === "correct" &&
		qc.verdict !== "correct" &&
		(q2 == null || q2.verdict === "correct");
	if (row.noise?.length) row.issues.push(`f64 noise: ${row.noise}`);
	if (row.diff.length) row.issues.push(`cand differs: ${row.diff}`);
	if (row.falseAccept)
		row.issues.push("cand accepts a verified-WRONG pose (false accept)");
	if (row.lostCorrect) row.issues.push("cand lost a verified-correct accept");
	if (row.changedAccept && qc.verdict !== "correct" && qc.verdict !== "wrong")
		row.issues.push(`cand accepts a ${qc.verdict} pose f64 did not show`);
	row.status = !row.diff.length
		? "identical"
		: row.noise?.length && row.diff.every((d) => row.noise.includes(d))
			? "within-noise"
			: "differs";
	return row;
}

/** Counts of accepted poses per verdict for mode `m` over the rows. */
export function acceptQuality(rows, m) {
	const c = {
		accepts: 0,
		correct: 0,
		wrong: 0,
		unsure: 0,
		unverified: 0,
	};
	for (const r of rows) {
		const q = r.quality?.[m];
		if (!q?.accepted) continue;
		c.accepts++;
		c[q.verdict] = (c[q.verdict] ?? 0) + 1;
	}
	return c;
}

/**
 * The verdict. The user judges on quality, not identity (2026-10-01): cand need not be bit-identical
 * to f64, it must not be worse.
 *   FAIL  cand has more verified-wrong accepts than base, fewer verified-correct accepts, or, on any
 *         one photo, accepts a verified-wrong pose / loses a verified-correct accept that f64 (base and
 *         base2: the noise floor) did not; or (with the eval arm) fewer GT-12 photos within 1° / a
 *         worse median error.
 *   NEEDS-VERIFY  cand accepts a pose f64 did not show (a new accept, or another pose than base's
 *         and base2's) and no blind verdict calls it correct or wrong: under the frozen
 *         0-false-accept rule it is a potential false accept until verified.
 *   INCONCLUSIVE  a photo errored, or cand never took a certified path (nothing was tested).
 *   PASS  otherwise. Identity (identical / within f64 noise / differs) is reported, not gated.
 */
export function decide({ rows, evalArm, vacuous }) {
	const ok = rows.filter((r) => r.status !== "error");
	const qb = acceptQuality(ok, "base");
	const qc = acceptQuality(ok, "cand");
	const reasons = [];
	if (qc.wrong > qb.wrong)
		reasons.push(`verified-wrong accepts ${qb.wrong} → ${qc.wrong}`);
	if (qc.correct < qb.correct)
		reasons.push(`verified-correct accepts ${qb.correct} → ${qc.correct}`);
	// per photo too: one new false accept traded against one lost elsewhere is still a new false accept
	const falseAccepts = ok.filter((r) => r.falseAccept).map((r) => r.id);
	const lostCorrect = ok.filter((r) => r.lostCorrect).map((r) => r.id);
	if (falseAccepts.length)
		reasons.push(`new verified-wrong accepts: ${falseAccepts.join(", ")}`);
	if (lostCorrect.length)
		reasons.push(`lost verified-correct accepts: ${lostCorrect.join(", ")}`);
	if (evalArm && !evalArm.error) {
		if (evalArm.within1deg[1] < evalArm.within1deg[0])
			reasons.push(`GT-12 within 1° ${evalArm.within1deg.join(" → ")}`);
		if (evalArm.medianAutoErr[1] > evalArm.medianAutoErr[0] + 0.5)
			reasons.push(
				`GT-12 median px error ${evalArm.medianAutoErr.map((x) => x.toFixed(1)).join(" → ")}`,
			);
	}
	// an accepted pose f64 did not show (new, or moved) without a correct verdict: unverified or unsure
	const unverifiedNew = ok.filter(
		(r) =>
			r.changedAccept &&
			r.quality.cand.verdict !== "correct" &&
			r.quality.cand.verdict !== "wrong",
	);
	const errors = rows.filter((r) => r.status === "error");
	const verdict = reasons.length
		? "FAIL"
		: errors.length || vacuous.length || evalArm?.error
			? "INCONCLUSIVE"
			: unverifiedNew.length
				? "NEEDS-VERIFY"
				: "PASS";
	return {
		verdict,
		reasons,
		quality: { base: qb, cand: qc, base2: acceptQuality(ok, "base2") },
		unverifiedNewAccepts: unverifiedNew.map((r) => r.id),
		identity: {
			identical: ok.filter((r) => r.status === "identical").length,
			withinNoise: ok.filter((r) => r.status === "within-noise").length,
			differs: ok.filter((r) => r.status === "differs").map((r) => r.id),
			noisy: ok.filter((r) => r.noise?.length).map((r) => r.id),
		},
		errors: errors.map((r) => r.id),
	};
}

export const EXIT = { PASS: 0, FAIL: 1, INCONCLUSIVE: 3, "NEEDS-VERIFY": 4 };
