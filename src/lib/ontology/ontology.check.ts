// npx tsx src/lib/ontology/ontology.check.ts — runtime integrity of the ontology and its agreement with
// the app. The compile-time half (crosswalk exhaustiveness, realizations) is tsc's job (checks/, crosswalk/).
//   1. catalogue: parents, parts, id schemes and storage refs resolve; words don't collide
//   2. ids: every scheme's example classifies as itself; real ids on disk classify as expected
//   3. storage: every Rigi-prefixed key literal in src/ is registered; every entry is still used
//   4. methods / scales: module paths exist; thresholds equal the app's exported constants
//   5. semantics: canonical HIGH == picker isAutoHigh on every reachable workspace state;
//      rollDisplay policy == roll.ts resolvePose order; known concord drift is exactly as recorded
//   6. reports/ontology.md is up to date (scripts/ontology/doc.ts)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { MIN_CONFIDENCE } from "#/lib/concord/app/confidence";
import { concordConfidence } from "#/lib/concord/app/useConcordDisplay";
import { poseAccepted } from "#/lib/nearfield/controller";
import { isAutoHigh } from "#/lib/picker/candidates";
import { anchorKind } from "#/lib/roll/propagate/plan";
import type { RollPhoto } from "#/lib/roll/types";
import { CONCEPTS, type ConceptId, DOMAINS } from "./catalogue/concepts";
import { CONFIDENCE_SCALES, levelOf } from "./core/confidence";
import {
	bboxFromSWNE,
	bboxFromWSEN,
	bboxToSWNE,
	bboxToWSEN,
} from "./core/geometry";
import {
	classifyId,
	ID_SCHEMES,
	parseUrn,
	photoKind,
	ref,
	toUrn,
} from "./core/ids";
import { METHODS } from "./core/provenance";
import { rebasePx } from "./core/quantity";
import { RESOLUTION_POLICIES, rankUnder } from "./core/resolution";
import {
	STORAGE,
	STORAGE_PREFIXES,
	type StorageId,
	storageEntryOf,
	storageKey,
} from "./core/storage";
import {
	ALIGN_STATE,
	type AlignState,
	isPropagationAnchor,
	POSE_SOURCE,
	reachableWorkspaceStates,
	SOLVE_METHOD,
	type SolveMethod,
	solvedPoseProvenance,
	staleVerifyStates,
	type Verify,
	workspaceIsSettled,
	workspaceIsTrustedAuto,
} from "./crosswalk/pose";
import { renderOntologyDoc } from "./doc";

const ROOT = new URL("../../../", import.meta.url).pathname;
let fails = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
	console.log(
		`${cond ? "ok  " : "FAIL"} ${msg}${detail && !cond ? `  — ${detail}` : ""}`,
	);
	if (!cond) fails++;
};
const readJson = (p: string) =>
	existsSync(join(ROOT, p))
		? JSON.parse(readFileSync(join(ROOT, p), "utf8"))
		: null;

// ---- 1. catalogue -------------------------------------------------------------------------------------
{
	const ids = new Set(Object.keys(CONCEPTS));
	const bad: string[] = [];
	const labels = new Map<string, string>();
	for (const [id, c] of Object.entries(CONCEPTS) as [
		ConceptId,
		(typeof CONCEPTS)[ConceptId],
	][]) {
		const d = c as {
			is?: string;
			has?: Record<string, { concept: string }>;
			ids?: string;
			storage?: readonly string[];
			avoid?: readonly string[];
		};
		if (d.is && !ids.has(d.is)) bad.push(`${id}.is → ${d.is}`);
		for (const [k, p] of Object.entries(d.has ?? {}))
			if (!ids.has(p.concept)) bad.push(`${id}.has.${k} → ${p.concept}`);
		if (d.ids && !ID_SCHEMES.some((s) => s.concept === d.ids))
			bad.push(`${id}.ids → ${d.ids}`);
		for (const s of d.storage ?? [])
			if (!(s in STORAGE)) bad.push(`${id}.storage → ${s}`);
		const prev = labels.get(c.label.toLowerCase());
		if (prev) bad.push(`label "${c.label}" on ${prev} and ${id}`);
		labels.set(c.label.toLowerCase(), id);
	}
	ok(
		bad.length === 0,
		`catalogue: ${ids.size} concepts, every reference resolves, labels unique`,
		bad.join("; "),
	);
	// is-a has no cycles
	const cyc = [...ids].filter((id) => {
		const seen = new Set<string>();
		let cur: string | undefined = id;
		while (cur) {
			if (seen.has(cur)) return true;
			seen.add(cur);
			cur = (CONCEPTS as Record<string, { is?: string }>)[cur]?.is;
		}
		return false;
	});
	ok(cyc.length === 0, "catalogue: is-a hierarchy is acyclic", cyc.join(","));
	const used = new Set(Object.values(CONCEPTS).map((c) => c.domain));
	ok(
		Object.keys(DOMAINS).every((d) => used.has(d as never)),
		"catalogue: every domain has concepts",
	);
}

// ---- 2. ids -------------------------------------------------------------------------------------------
{
	const wrong = ID_SCHEMES.filter(
		(s) =>
			classifyId(s.concept, s.example) !== s.kind &&
			!(s.concept === "roll" && s.kind === "bundled"),
	);
	ok(
		wrong.length === 0,
		`ids: ${ID_SCHEMES.length} schemes, each example classifies as itself`,
		wrong.map((s) => s.example).join(","),
	);
	ok(
		classifyId("roll", "region-3") === "bundled",
		"ids: a bundled roll id is its region id",
	);
	ok(
		photoKind("local-region-46.55_7.95") === null &&
			photoKind("local-roll-3fa9c1d2e4") === null &&
			photoKind("demo-region") === null,
		"ids: photoKind is not fooled by local-region-/local-roll-/demo-region",
	);
	const urn = toUrn(ref("dem-tile", "12/2138/1447"));
	const back = parseUrn(urn);
	ok(
		back?.concept === "dem-tile" && back.id === "12/2138/1447",
		`ids: URN round-trips (${urn})`,
	);

	const photos = readJson("public/photos/photos.json") as
		| { id: string; region: string }[]
		| null;
	if (photos) {
		ok(
			photos.every(
				(p) =>
					classifyId("photo", p.id) === "bundled" &&
					photoKind(p.id) === "bundled",
			),
			`ids: ${photos.length} bundled photos classify as photo/bundled`,
		);
		ok(
			photos.every((p) => classifyId("region", p.region) === "bundled"),
			"ids: their regions classify as region/bundled",
		);
	} else console.log("skip ids: public/photos/photos.json missing");
	const demo = readJson("public/demo/manifest.json") as {
		photos: { id: string }[];
		region: { id: string };
	} | null;
	if (demo)
		ok(
			demo.photos.every((p) => classifyId("photo", p.id) === "demo") &&
				classifyId("region", demo.region.id) === "demo",
			`ids: ${demo.photos.length} demo photos + region classify as demo`,
		);
	const split = readJson("tools/bench/split.json") as {
		dev: string[];
		test: string[];
	} | null;
	if (split) {
		const all = [...split.dev, ...split.test];
		const bench = all.filter((id) => id.startsWith("wc_"));
		ok(
			bench.every((id) => classifyId("photo", id) === "bench"),
			`ids: ${bench.length} wild-benchmark ids classify as photo/bench`,
		);
	}
	const gt = readJson("data/ground-truth.json") as Record<
		string,
		unknown
	> | null;
	if (gt)
		ok(
			Object.keys(gt).every((id) => classifyId("photo", id) === "bundled"),
			`ids: ${Object.keys(gt).length} ground-truth keys are bundled photo ids`,
		);
}

// ---- 3. storage ---------------------------------------------------------------------------------------
{
	const files: string[] = [];
	const walk = (d: string) => {
		for (const n of readdirSync(d)) {
			const p = join(d, n);
			if (statSync(p).isDirectory()) walk(p);
			else if (
				/\.(ts|tsx)$/.test(n) &&
				!/\.check\.ts$/.test(n) &&
				!p.includes("/ontology/")
			)
				files.push(p);
		}
	};
	walk(join(ROOT, "src"));
	const prefix = STORAGE_PREFIXES.map((p) => p.replace(/[.-]/g, "\\$&")).join(
		"|",
	);
	const lit = new RegExp(`["'\`]((?:${prefix})[^"'\`\\s]*)["'\`]`, "g");
	const unregistered: string[] = [];
	const hit = new Set<StorageId>();
	for (const f of files) {
		const src = readFileSync(f, "utf8");
		for (const m of src.matchAll(lit)) {
			const key = m[1].replace(/\$\{[^}]*\}/g, "x");
			const id = storageEntryOf(key);
			if (id) hit.add(id);
			else unregistered.push(`${relative(ROOT, f)}: ${m[1]}`);
		}
	}
	ok(
		unregistered.length === 0,
		`storage: every Rigi-prefixed key literal in src/ is registered (${files.length} files)`,
		unregistered.join("; "),
	);
	ok(
		storageKey("savedPose", "IMG_1") === "mt-image:pose:IMG_1" &&
			storageKey("propagate") === "mt-image:propagate:v1",
		"storage: storageKey fills holes",
	);
	const prefixed = (Object.keys(STORAGE) as StorageId[]).filter((id) =>
		STORAGE_PREFIXES.some((p) => STORAGE[id].key.startsWith(p)),
	);
	// keys built with storageKey("<id>", …) count as used
	for (const f of files)
		for (const m of readFileSync(f, "utf8").matchAll(
			/storageKey\(\s*"([A-Za-z]+)"/g,
		))
			if (m[1] in STORAGE) hit.add(m[1] as StorageId);
	const stale = prefixed.filter((id) => !hit.has(id));
	ok(
		stale.length === 0,
		"storage: every registered prefixed key is still used",
		stale.join(","),
	);
}

// ---- 4. methods / scales / geometry -------------------------------------------------------------------
{
	const missing: string[] = [];
	for (const [id, m] of Object.entries(METHODS))
		for (const part of m.module.split(",")) {
			const path = part.trim().split(" ")[0];
			const full =
				path.startsWith("data/") || path.startsWith("tools/")
					? join(ROOT, path)
					: join(ROOT, "src", path);
			if (!existsSync(full)) missing.push(`${id}: ${path}`);
		}
	ok(
		missing.length === 0,
		`methods: ${Object.keys(METHODS).length} methods, every module path exists`,
		missing.join("; "),
	);
	ok(
		CONFIDENCE_SCALES.concord.high === MIN_CONFIDENCE,
		`confidence: concord scale = concord MIN_CONFIDENCE (${MIN_CONFIDENCE})`,
	);
	ok(
		levelOf("matcher", 0.9) === "high" && levelOf("matcher", 0.2) === "low",
		"confidence: matcher 0.9 → high, 0.2 → low",
	);
	ok(
		levelOf("skyline-align", 0.99) === "medium" &&
			levelOf("skyline-align", 0.1) === "low",
		"confidence: autoAlign alone is never high",
	);
	ok(levelOf("refine", null) === "unknown", "confidence: null score → unknown");
	const b = bboxFromWSEN([7, 46, 8, 47]);
	ok(
		bboxToSWNE(b).join() === "46,7,47,8" &&
			bboxToWSEN(bboxFromSWNE(bboxToSWNE(b))).join() === "7,46,8,47",
		"geometry: bbox WSEN ↔ SWNE round-trip",
	);
	const size = { width: 4000, height: 3000 };
	ok(
		Math.abs(rebasePx(4, "wide1600", "work", size) - 10) < 1e-9 &&
			Math.abs(
				rebasePx(16, "long1600", "wide1600", { width: 3000, height: 4000 }) -
					16 * (1600 / ((1600 * 3000) / 4000)),
			) < 1e-9,
		"quantity: pixel-basis rebase",
	);
}

// ---- 5. semantics -------------------------------------------------------------------------------------
{
	const states = reachableWorkspaceStates();
	const disagree = states.filter(
		([a, v]) => workspaceIsTrustedAuto(a, v) !== isAutoHigh(a, v),
	);
	ok(
		disagree.length === 0,
		`semantics: canonical trusted-auto == picker isAutoHigh on all ${states.length} reachable workspace states`,
		disagree.map((s) => s.join("+")).join(", "),
	);

	// nearfield's gate: a person's pose OR a trusted automatic one, on reachable AND stale states
	const all = [...states, ...staleVerifyStates()];
	const nfDiff = all.filter(
		([a, v]) => poseAccepted(a, v) !== workspaceIsSettled(a, v),
	);
	ok(
		nfDiff.length === 0,
		`semantics: canonical settled == nearfield poseAccepted on all ${all.length} states (incl. stale)`,
		nfDiff.map((s) => s.join("+")).join(", "),
	);
	const pickerStale = staleVerifyStates().filter(
		([a, v]) => workspaceIsTrustedAuto(a, v) !== isAutoHigh(a, v),
	);
	ok(
		pickerStale.length === 0,
		"semantics: picker isAutoHigh also ignores stale verdicts on a person's pose",
	);

	// concord's own rule differs from canonical only on the stale-verdict states, which are unreachable
	// since b9d29b1 (PhotoWorkspace clears verify when a person's pose is applied). On every reachable
	// state the three gates (picker, nearfield, concord) agree with the ontology.
	ok(
		!states.some(
			([a, v]) =>
				(concordConfidence({
					pose: {},
					settled: true,
					alignState: a,
					verify: v === "pending" ? null : v,
				}) !==
					null) !==
					workspaceIsTrustedAuto(a, v) && v !== "pending",
		),
		"semantics: concordConfidence == canonical on every reachable workspace state",
	);

	// propagation anchors: plan.ts anchorKind == canonical isPropagationAnchor over PoseSource × SolveMethod × mode
	const anchorDiff: string[] = [];
	for (const mode of ["off", "on", "dev"] as const)
		for (const src of Object.keys(POSE_SOURCE) as (keyof typeof POSE_SOURCE)[])
			for (const sm of Object.keys(SOLVE_METHOD) as SolveMethod[]) {
				const app =
					anchorKind(
						{ poseSource: src } as RollPhoto,
						mode,
						src === "solved" ? sm : null,
					) !== null;
				const prov =
					src === "solved" ? solvedPoseProvenance(sm) : POSE_SOURCE[src];
				if (app !== isPropagationAnchor(prov, mode))
					anchorDiff.push(`${mode}/${src}/${sm}`);
			}
	ok(
		anchorDiff.length === 0,
		"semantics: propagate anchorKind == canonical isPropagationAnchor (no chaining, GT only in dev)",
		anchorDiff.join(", "),
	);

	// rollDisplay ranks the roll's pose sources in the order roll.ts resolvePose returns them
	const src = readFileSync(join(ROOT, "src/lib/roll/roll.ts"), "utf8");
	const body = src.slice(src.indexOf("export function resolvePose"));
	const order = [
		...body.slice(0, body.indexOf("\n}\n")).matchAll(/source: "([a-z-]+)"/g),
	].map((m) => m[1]);
	const byPolicy = (
		Object.keys(POSE_SOURCE) as (keyof typeof POSE_SOURCE)[]
	).sort(
		(a, b) =>
			rankUnder("rollDisplay", POSE_SOURCE[a]) -
			rankUnder("rollDisplay", POSE_SOURCE[b]),
	);
	ok(
		order.join() === byPolicy.join(),
		`semantics: rollDisplay policy order = resolvePose order (${order.join(" > ")})`,
		`policy ${byPolicy.join(" > ")}`,
	);
	ok(
		rankUnder("evaluation", POSE_SOURCE["ground-truth"]) < 0,
		"semantics: evaluation never chooses ground truth (oracle)",
	);
	ok(
		rankUnder("rollStateless", POSE_SOURCE.saved) < 0 &&
			rankUnder("rollStateless", POSE_SOURCE.solved) < 0 &&
			rankUnder("rollStateless", POSE_SOURCE["ground-truth"]) === 0,
		"semantics: rollStateless = ground truth, else prior (resolvePose ignoreStored)",
	);
	ok(
		Object.values(RESOLUTION_POLICIES).every((p) => p.rules.length > 0),
		"semantics: every policy has rules",
	);
	const userStates = (Object.keys(ALIGN_STATE) as AlignState[]).filter(
		(a) =>
			workspaceIsTrustedAuto(a, null as Verify) &&
			"agent" in ALIGN_STATE[a] &&
			ALIGN_STATE[a].agent === "user",
	);
	ok(
		userStates.length === 0,
		"semantics: a person's pose is never 'trusted auto'",
	);
}

// ---- 6. docs ------------------------------------------------------------------------------------------
{
	const path = join(ROOT, "reports/ontology.md");
	const cur = existsSync(path) ? readFileSync(path, "utf8") : "";
	ok(
		cur === renderOntologyDoc(),
		"docs: reports/ontology.md is current (npx tsx scripts/ontology/doc.ts)",
	);
}

console.log(fails ? `\n${fails} FAILED` : "\nall ok");
process.exit(fails ? 1 : 0);
