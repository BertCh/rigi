// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * H1 blind-verification support (PROTOCOL.txt, "Suggested decision rule"): verdict vocabulary, seeded
 * ordering, two-verifier merge, and the scorer that joins merged verdicts with the key AFTER verification
 * and emits the hard-negative list in the format the H2 veto evaluator reads (../../h2_veto).
 *
 * Pure functions only; the CLIs (check_pack.ts, make_session.ts, merge_verdicts.ts, score_verdicts.ts) do the I/O.
 * Nothing here reads the real key unless a CLI is pointed at it by the human running the scoring step.
 */

export const VERDICTS_SCHEMA = "h1-verdicts/1";
export const HARDNEG_SCHEMA = "h1-hardneg/1";

/** What a verifier can record. "near-miss" is scored as wrong (protocol: near-miss = wrong). */
export const RAW_VERDICTS = [
	"correct",
	"wrong",
	"near-miss",
	"unsure",
	"not-seen",
] as const;
export type RawVerdict = (typeof RAW_VERDICTS)[number];
/** Scored vocabulary after normalisation. */
export type Verdict = "correct" | "wrong" | "unsure";

export interface VerdictEntry {
	verdict: RawVerdict;
	/** C1 coverage, C2 vertical fit, C3 feature alignment, C4 tilt: true = passes, null = not judged. */
	checks?: Partial<Record<"C1" | "C2" | "C3" | "C4", boolean | null>>;
	note?: string;
	ts?: string;
}

export interface VerdictsFile {
	schema: typeof VERDICTS_SCHEMA;
	verifier: string;
	batch: number | null;
	startedAt: string;
	savedAt: string;
	/** folder -> label -> entry. Folder names are the hashed pack folders. */
	verdicts: Record<string, Record<string, VerdictEntry>>;
}

export type KeyKind =
	| "candidate"
	| "pilot"
	| "duplicate"
	| "construct-check"
	| "positive-control"
	| `decoy-yaw${string}`;

export interface KeyItem {
	pid: string;
	kind: KeyKind;
	cid?: string;
	ref?: string;
	pose: { yaw: number; pitch: number; roll: number; vfov: number };
	eye: { lat: number; lon: number; h: number };
	width?: number;
	folder: string;
}
export interface KeyFile {
	candidates: Record<string, KeyItem>;
}

export interface PoolRecord {
	pid: string;
	cid: string;
	status: string;
	label?: string | null;
	inherit?: { verdict: string } | null;
	pose: KeyItem["pose"];
	eye: KeyItem["eye"];
}

/** Pool cids are per photo (k000...); this id matches the E1 / GA5 hypothesis id format (wc_0001_k000). */
export function hypId(pid: string, cid: string): string {
	return `${pid}_${cid}`;
}

export function normaliseVerdict(raw: RawVerdict): Verdict {
	if (raw === "correct") return "correct";
	if (raw === "wrong" || raw === "near-miss") return "wrong";
	return "unsure"; // unsure and not-seen
}

export function isRawVerdict(v: unknown): v is RawVerdict {
	return (RAW_VERDICTS as readonly unknown[]).includes(v);
}

/** Throws a descriptive Error for a malformed verdicts file. */
export function validateVerdictsFile(f: unknown): VerdictsFile {
	const o = f as Partial<VerdictsFile> | null;
	if (!o || o.schema !== VERDICTS_SCHEMA)
		throw new Error(`verdicts file: schema must be ${VERDICTS_SCHEMA}`);
	if (typeof o.verifier !== "string" || !o.verifier)
		throw new Error("verdicts file: verifier id missing");
	if (typeof o.savedAt !== "string")
		throw new Error("verdicts file: savedAt missing");
	if (!o.verdicts || typeof o.verdicts !== "object")
		throw new Error("verdicts file: verdicts missing");
	for (const [folder, items] of Object.entries(o.verdicts))
		for (const [label, e] of Object.entries(items))
			if (!isRawVerdict(e?.verdict))
				throw new Error(
					`verdicts file: bad verdict for ${folder}/${label}: ${String(e?.verdict)}`,
				);
	return o as VerdictsFile;
}

// ---- seeded ordering ---------------------------------------------------------------------------

export function hashSeed(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Deterministic Fisher-Yates; the input is not modified. */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
	const rng = mulberry32(hashSeed(seed));
	const a = items.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

export interface SessionItem {
	folder: string;
	label: string;
	photo: string;
	overlay: string;
}

/**
 * Order for one verifier on one batch: folders shuffled, then each folder's overlays shuffled, all seeded by
 * the verifier id so two verifiers see different orders but a re-opened session sees the same one.
 * All overlays of a photo stay adjacent (protocol: verify every candidate of a folder in the same sitting).
 */
export function buildSessionOrder(
	folders: Record<string, string[]>,
	verifier: string,
	batchFolders: string[],
	seed = 20260928,
): SessionItem[] {
	const out: SessionItem[] = [];
	for (const folder of seededShuffle(
		[...batchFolders].sort(),
		`${seed}:${verifier}:folders`,
	)) {
		const labels = seededShuffle(
			[...(folders[folder] ?? [])].sort(),
			`${seed}:${verifier}:${folder}`,
		);
		for (const label of labels)
			out.push({
				folder,
				label,
				photo: `${folder}/photo.jpg`,
				overlay: `${folder}/candidate_${label}.jpg`,
			});
	}
	return out;
}

// ---- merging -----------------------------------------------------------------------------------

export type MergeRule = "protocol" | "strict";

/**
 * Two (or more) verifiers on the same overlay.
 * protocol: correct iff all say correct; wrong if any says wrong; otherwise unsure
 *   (PROTOCOL.txt / tools/matcher/v2/verify/PROTOCOL.md).
 * strict: any disagreement is unsure (bench-wild.md "disagreements count as unsure").
 * A single verdict is returned as-is, but scoreVerdicts flags it as single-verifier.
 */
export function mergeVerdicts(
	verdicts: readonly Verdict[],
	rule: MergeRule = "protocol",
): Verdict {
	if (verdicts.length === 0) return "unsure";
	if (verdicts.every((v) => v === verdicts[0])) return verdicts[0];
	if (rule === "strict") return "unsure";
	return verdicts.includes("wrong") ? "wrong" : "unsure";
}

/** Merge several verdict files into one entry map keyed folder/label with the per-verifier raw verdicts. */
export function collectByLabel(
	files: readonly VerdictsFile[],
): Map<
	string,
	{ folder: string; label: string; byVerifier: Record<string, RawVerdict> }
> {
	const m = new Map<
		string,
		{ folder: string; label: string; byVerifier: Record<string, RawVerdict> }
	>();
	for (const f of files)
		for (const [folder, items] of Object.entries(f.verdicts))
			for (const [label, e] of Object.entries(items)) {
				const k = `${folder}/${label}`;
				const cur = m.get(k) ?? { folder, label, byVerifier: {} };
				cur.byVerifier[f.verifier] = e.verdict;
				m.set(k, cur);
			}
	return m;
}

export interface MergedVerdicts {
	schema: "h1-merged/1";
	rule: MergeRule;
	verifiers: string[];
	/** label -> final normalised verdict + per-verifier raw verdicts. */
	labels: Record<
		string,
		{
			verdict: Verdict;
			byVerifier: Record<string, RawVerdict>;
			singleVerifier: boolean;
			folder: string;
		}
	>;
}

/**
 * One verifier may hand in several files (one per batch): union them per verifier id.
 * The same label in two files of one verifier is an error (a duplicate or re-used id).
 */
export function combineByVerifier(
	files: readonly VerdictsFile[],
): VerdictsFile[] {
	const by = new Map<string, VerdictsFile>();
	for (const f of files) {
		const cur = by.get(f.verifier);
		if (!cur) {
			by.set(f.verifier, structuredClone(f));
			continue;
		}
		for (const [folder, items] of Object.entries(f.verdicts))
			for (const [label, e] of Object.entries(items)) {
				if (cur.verdicts[folder]?.[label])
					throw new Error(
						`verifier ${f.verifier}: ${folder}/${label} appears in two files (overlap)`,
					);
				cur.verdicts[folder] = cur.verdicts[folder] ?? {};
				cur.verdicts[folder][label] = e;
			}
		cur.batch = null;
		if (f.savedAt > cur.savedAt) cur.savedAt = f.savedAt;
		if (f.startedAt < cur.startedAt) cur.startedAt = f.startedAt;
	}
	return [...by.values()];
}

export function mergeFiles(
	rawFiles: readonly VerdictsFile[],
	rule: MergeRule = "protocol",
): MergedVerdicts {
	const files = combineByVerifier(rawFiles);
	const ids = files.map((f) => f.verifier);
	const labels: MergedVerdicts["labels"] = {};
	for (const { folder, label, byVerifier } of collectByLabel(files).values()) {
		const vs = Object.values(byVerifier).map(normaliseVerdict);
		labels[label] = {
			verdict: mergeVerdicts(vs, rule),
			byVerifier,
			singleVerifier: vs.length < 2,
			folder,
		};
	}
	return { schema: "h1-merged/1", rule, verifiers: ids, labels };
}

// ---- scoring -----------------------------------------------------------------------------------

export type HardNegSource =
	| "blind-wrong"
	| "wrong-construct"
	| "inherited-wrong";
export type CorrectSource =
	| "blind-correct"
	| "inherited-correct"
	| "positive-control";

export interface HardNegItem {
	id: string;
	source: HardNegSource;
	pid: string;
	cid: string | null;
	pose: KeyItem["pose"];
	eye: KeyItem["eye"];
	label?: string;
}
export interface CorrectItem {
	id: string;
	source: CorrectSource;
	pid: string;
	cid: string | null;
	pose: KeyItem["pose"];
	eye: KeyItem["eye"];
	label?: string;
}

export interface HardNegFile {
	schema: typeof HARDNEG_SCHEMA;
	rule: MergeRule;
	counts: {
		blindWrong: number;
		wrongConstruct: number;
		inheritedWrong: number;
		hardNegativesTotal: number;
		blindCorrect: number;
		inheritedCorrect: number;
		positiveControls: number;
		blindUnsure: number;
		blindMissing: number;
		singleVerifierLabels: number;
	};
	hardNegatives: HardNegItem[];
	verifiedCorrect: CorrectItem[];
	qc: {
		duplicateDisagreements: { verifier: string; cid: string }[];
		/** constructCheck: wrong-by-construction items that were packed; agreed = merged verdict wrong. */
		constructCheck: {
			packed: number;
			agreedWrong: number;
			labels: Record<string, Verdict>;
		};
		positiveControlFailures: { verifier: string; label: string }[];
		decoyAccepted: { verifier: string; label: string }[];
		flaggedVerifiers: string[];
	};
}

/**
 * Join merged verdicts with the key (+ pool for the two label-by-construction/inheritance sources).
 * Per verifier, a candidate whose duplicate pair (same cid) disagrees becomes unsure for that verifier before merging.
 * A cid counts once; if its candidate and duplicate overlays merge differently the less committal verdict wins
 * (correct+wrong -> unsure).
 */
export function scoreVerdicts(
	rawFiles: readonly VerdictsFile[],
	key: KeyFile,
	pool: readonly PoolRecord[],
	rule: MergeRule = "protocol",
): HardNegFile {
	const files = combineByVerifier(rawFiles);
	// Per-verifier duplicate handling on the raw files.
	const dupDis: { verifier: string; cid: string }[] = [];
	const adjusted: VerdictsFile[] = files.map((f) => {
		const byCid = new Map<
			string,
			{ folder: string; label: string; v: Verdict; cid: string }[]
		>();
		for (const [folder, items] of Object.entries(f.verdicts))
			for (const [label, e] of Object.entries(items)) {
				const k = key.candidates[label];
				if (
					!k ||
					!k.cid ||
					!(
						k.kind === "candidate" ||
						k.kind === "pilot" ||
						k.kind === "duplicate"
					)
				)
					continue;
				const arr = byCid.get(hypId(k.pid, k.cid)) ?? [];
				arr.push({ folder, label, v: normaliseVerdict(e.verdict), cid: k.cid });
				byCid.set(hypId(k.pid, k.cid), arr);
			}
		const verdicts = structuredClone(f.verdicts);
		for (const arr of byCid.values()) {
			if (arr.length > 1 && !arr.every((a) => a.v === arr[0].v)) {
				dupDis.push({ verifier: f.verifier, cid: arr[0].cid });
				for (const a of arr)
					verdicts[a.folder][a.label] = { verdict: "unsure" };
			}
		}
		return { ...f, verdicts };
	});
	const merged = mergeFiles(adjusted, rule);

	const hard: HardNegItem[] = [];
	const correct: CorrectItem[] = [];
	const counts = {
		blindWrong: 0,
		wrongConstruct: 0,
		inheritedWrong: 0,
		hardNegativesTotal: 0,
		blindCorrect: 0,
		inheritedCorrect: 0,
		positiveControls: 0,
		blindUnsure: 0,
		blindMissing: 0,
		singleVerifierLabels: 0,
	};

	// Blind candidates: one decision per cid over its candidate + duplicate overlays.
	const cidVerdicts = new Map<
		string,
		{ item: KeyItem; label: string; vs: Verdict[] }
	>();
	for (const [label, k] of Object.entries(key.candidates)) {
		if (
			!k.cid ||
			!(k.kind === "candidate" || k.kind === "pilot" || k.kind === "duplicate")
		)
			continue;
		const m = merged.labels[label];
		const e = cidVerdicts.get(hypId(k.pid, k.cid)) ?? {
			item: k,
			label,
			vs: [] as Verdict[],
		};
		if (k.kind !== "duplicate") {
			e.item = k;
			e.label = label;
		}
		if (m) {
			e.vs.push(m.verdict);
			if (m.singleVerifier) counts.singleVerifierLabels++;
		}
		cidVerdicts.set(hypId(k.pid, k.cid), e);
	}
	for (const [uid, e] of cidVerdicts) {
		const cid = e.item.cid as string;
		if (e.vs.length === 0) {
			counts.blindMissing++;
			continue;
		}
		const v = e.vs.every((x) => x === e.vs[0]) ? e.vs[0] : "unsure";
		const base = {
			id: `blind:${uid}`,
			pid: e.item.pid,
			cid,
			pose: e.item.pose,
			eye: e.item.eye,
			label: e.label,
		};
		if (v === "wrong") {
			hard.push({ ...base, source: "blind-wrong" });
			counts.blindWrong++;
		} else if (v === "correct") {
			correct.push({ ...base, source: "blind-correct" });
			counts.blindCorrect++;
		} else counts.blindUnsure++;
	}

	// Pool-derived sources (no overlay verdict needed).
	for (const r of pool) {
		if (r.status === "wrong-construct") {
			hard.push({
				id: `construct:${hypId(r.pid, r.cid)}`,
				source: "wrong-construct",
				pid: r.pid,
				cid: r.cid,
				pose: r.pose,
				eye: r.eye,
			});
			counts.wrongConstruct++;
		} else if (r.status === "inherited") {
			if (r.inherit?.verdict === "wrong") {
				hard.push({
					id: `inherited:${hypId(r.pid, r.cid)}`,
					source: "inherited-wrong",
					pid: r.pid,
					cid: r.cid,
					pose: r.pose,
					eye: r.eye,
				});
				counts.inheritedWrong++;
			} else if (r.inherit?.verdict === "correct") {
				correct.push({
					id: `inherited:${hypId(r.pid, r.cid)}`,
					source: "inherited-correct",
					pid: r.pid,
					cid: r.cid,
					pose: r.pose,
					eye: r.eye,
				});
				counts.inheritedCorrect++;
			}
		}
	}

	// QC: positive controls (verified-correct refs) join the correct set only when the merged verdict agrees.
	const pcFail: { verifier: string; label: string }[] = [];
	const decoyAcc: { verifier: string; label: string }[] = [];
	const ccLabels: Record<string, Verdict> = {};
	let ccPacked = 0;
	let ccAgreed = 0;
	for (const [label, k] of Object.entries(key.candidates)) {
		const m = merged.labels[label];
		if (k.kind === "positive-control") {
			if (m?.verdict === "correct") {
				correct.push({
					id: `control:${label}`,
					source: "positive-control",
					pid: k.pid,
					cid: null,
					pose: k.pose,
					eye: k.eye,
					label,
				});
				counts.positiveControls++;
			}
			for (const [vid, rv] of Object.entries(m?.byVerifier ?? {}))
				if (normaliseVerdict(rv) !== "correct")
					pcFail.push({ verifier: vid, label });
		} else if (k.kind.startsWith("decoy")) {
			for (const [vid, rv] of Object.entries(m?.byVerifier ?? {}))
				if (normaliseVerdict(rv) === "correct")
					decoyAcc.push({ verifier: vid, label });
		} else if (k.kind === "construct-check") {
			ccPacked++;
			if (m) {
				ccLabels[label] = m.verdict;
				if (m.verdict === "wrong") ccAgreed++;
			}
		}
	}
	counts.hardNegativesTotal = hard.length;
	return {
		schema: HARDNEG_SCHEMA,
		rule,
		counts,
		hardNegatives: hard,
		verifiedCorrect: correct,
		qc: {
			duplicateDisagreements: dupDis,
			constructCheck: {
				packed: ccPacked,
				agreedWrong: ccAgreed,
				labels: ccLabels,
			},
			positiveControlFailures: pcFail,
			decoyAccepted: decoyAcc,
			flaggedVerifiers: [
				...new Set([...pcFail, ...decoyAcc].map((x) => x.verifier)),
			].sort(),
		},
	};
}
