// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Renders reports/ontology.md from the catalogues (pure: strings in, string out). Written by
// scripts/ontology/doc.ts; ontology.check.ts fails when the file is stale.

import { CONCEPTS, type ConceptDef, DOMAINS } from "./catalogue/concepts";
import { FINDINGS } from "./catalogue/findings";
import { CONFIDENCE_SCALES } from "./core/confidence";
import { ID_SCHEMES } from "./core/ids";
import {
	AGENTS,
	EVIDENCE,
	METHODS,
	OUTCOMES,
	type ProvenanceClass,
	ROLES,
	STATUSES,
} from "./core/provenance";
import { PIXEL_BASES } from "./core/quantity";
import { RESOLUTION_POLICIES } from "./core/resolution";
import { STORAGE } from "./core/storage";
import * as pose from "./crosswalk/pose";
import * as presentation from "./crosswalk/presentation";
import * as world from "./crosswalk/world";

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const code = (xs: readonly string[] | undefined) =>
	(xs ?? []).map((x) => `\`${esc(x)}\``).join(", ");
const table = (head: string[], rows: string[][]) =>
	[
		`| ${head.join(" | ")} |`,
		`|${head.map(() => "---").join("|")}|`,
		...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
	].join("\n");

const prov = (p: ProvenanceClass) =>
	(
		[
			"agent",
			"method",
			"role",
			"status",
			"outcome",
			"corroborated",
			"level",
		] as const
	)
		.filter((k) => p[k] !== undefined)
		.map((k) => `${k}=${String(p[k])}`)
		.join(" · ");

const CROSSWALKS: [string, string, Record<string, ProvenanceClass>][] = [
	["PoseSource", "lib/roll/types.ts", pose.POSE_SOURCE],
	["SolvedPose.method", "lib/roll (align, propagate)", pose.SOLVE_METHOD],
	["AlignState", "components/PhotoWorkspace.tsx", pose.ALIGN_STATE],
	["SecondOpinionVerdict", "lib/integration/second-opinion.ts", pose.VERDICT],
	[
		"SecondOpinion.matcher",
		"lib/integration/second-opinion.ts",
		pose.MATCHER_STATE,
	],
	[
		"UnknownPoseOutcome.state",
		"lib/integration/unknown-pose.ts",
		pose.UNKNOWN_OUTCOME_STATE,
	],
	[
		"UnknownPoseOutcome.source",
		"lib/integration/unknown-pose.ts",
		pose.UNKNOWN_OUTCOME_SOURCE,
	],
	["CandidateSource", "lib/picker/candidates.ts", pose.CANDIDATE_SOURCE],
	[
		"RelRotationEvidence.method",
		"lib/nearfield/propagate.ts",
		pose.RELATIVE_ROTATION_METHOD,
	],
	["AlignStatus (roll)", "lib/roll/align/align.ts", pose.ROLL_ALIGN_STATUS],
	[
		"RowStatus (propagate)",
		"lib/roll/propagate/run.ts",
		pose.PROPAGATE_ROW_STATUS,
	],
	[
		"StoredSuggestion.status",
		"lib/roll/propagate/store.ts",
		pose.SUGGESTION_STATUS,
	],
	[
		"positionSource (upload)",
		"lib/upload/exif.ts",
		world.UPLOAD_POSITION_SOURCE,
	],
	[
		"positionSource() (matcher)",
		"lib/integration/unknown-pose.ts",
		world.MATCHER_POSITION_SOURCE,
	],
	[
		"PositionProvenance.method",
		"lib/roll/import/provenance.ts",
		world.IMPORT_POSITION_METHOD,
	],
	["Placement.kind", "lib/roll/import/index.ts", world.PLACEMENT],
	["EyePrior.source", "lib/concord/priors/altitude.ts", world.EYE_PRIOR_SOURCE],
	["timeSource", "lib/upload/exif.ts", world.TIME_SOURCE],
	["LakeLevel.source", "lib/geocam/lakes/levels.ts", world.LAKE_LEVEL_SOURCE],
	[
		"InteriorPin.source",
		"lib/concord/core/types.ts",
		world.INTERIOR_PIN_SOURCE,
	],
	["nearfield Provenance", "lib/nearfield/types.ts", world.SPLAT_PROVENANCE],
	["SkyMask.source", "lib/sky/index.ts", world.SKY_SOURCE],
	[
		"SpotDepthSource",
		"lib/nearfield/roll/roll-spot.ts",
		world.SPOT_DEPTH_SOURCE,
	],
];

export function renderOntologyDoc(): string {
	const out: string[] = [];
	const concepts = Object.entries(CONCEPTS) as [string, ConceptDef][];
	out.push(
		"# Rigi ontology",
		"",
		"GENERATED from `src/lib/ontology` by `npx tsx scripts/ontology/doc.ts`. Do not edit by hand.",
		"`npx tsx src/lib/ontology/ontology.check.ts` fails while this file is stale. The design rationale is in `reports/ontology-design.md`.",
		"",
		"The ontology is Rigi's meta layer. It names every concept once, defines the semantic axes along which values are known (provenance, confidence, units, frames, ids), and maps every existing type and union onto them. The mapping is checked by tsc (crosswalks and realizations) and by `ontology.check.ts` (semantics, ids, storage, docs).",
		"",
		"## Contents",
		"1. [Concepts](#concepts) · 2. [Concept graph](#concept-graph) · 3. [Realizations](#realizations) · 4. [Provenance axes](#provenance-axes) · 5. [Methods](#methods) · 6. [Crosswalks](#crosswalks) · 7. [Confidence scales](#confidence-scales) · 8. [Resolution policies](#resolution-policies) · 9. [Units and frames](#units-and-frames) · 10. [Identifiers](#identifiers) · 11. [Storage](#storage) · 12. [Findings](#findings)",
		"",
		"## Concepts",
		"",
	);
	for (const [d, blurb] of Object.entries(DOMAINS)) {
		out.push(`### ${d[0].toUpperCase()}${d.slice(1)}`, "", `_${blurb}_`, "");
		out.push(
			table(
				["concept", "definition", "UI words", "code words", "avoid"],
				concepts
					.filter(([, c]) => c.domain === d)
					.map(([id, c]) => [
						`**${c.label}** \`${id}\`${c.is ? ` (is ${c.is})` : ""}`,
						c.definition + (c.note ? ` _Note: ${c.note}_` : ""),
						(c.ui ?? []).join(", "),
						code(c.code),
						(c.avoid ?? []).join("; "),
					]),
			),
			"",
		);
	}

	out.push("## Concept graph", "", "```mermaid", "graph LR");
	for (const [id, c] of concepts) {
		if (c.is)
			out.push(`  ${id.replace(/-/g, "_")} -->|is| ${c.is.replace(/-/g, "_")}`);
		for (const [k, p] of Object.entries(c.has ?? {}))
			out.push(
				`  ${id.replace(/-/g, "_")} -->|${k} ${p.card}| ${p.concept.replace(/-/g, "_")}`,
			);
	}
	out.push("```", "");

	out.push(
		"## Realizations",
		"",
		"These are the TypeScript types that realize each concept. The first is canonical. `checks/realizations.ts` proves that each one exists.",
		"",
		table(
			["concept", "types"],
			concepts.map(([id, c]) => [`\`${id}\``, code(c.realizedBy)]),
		),
		"",
	);

	out.push(
		"## Provenance axes",
		"",
		"A value's provenance is recorded on independent axes. It is never folded into a single `source` string. `Provenance` is a sidecar that sits next to the value and does not wrap it.",
		"",
	);
	for (const [name, t] of [
		["Agent: who produced it", AGENTS],
		["Role: how it is used", ROLES],
		["Status: where it stands in being judged", STATUSES],
		["Outcome: what a verification did", OUTCOMES],
		[
			"Evidence: what it rests on (the first 13 are exactly geocam `CueFamily`)",
			EVIDENCE,
		],
	] as const)
		out.push(
			`### ${name}`,
			"",
			table(
				["term", "meaning"],
				Object.entries(t).map(([k, v]) => [`\`${k}\``, v]),
			),
			"",
		);
	out.push(
		"Trusted auto (`isTrustedAuto`) means: an automatic agent, status `accepted`, and either corroborated or at `high` level. A person's own pose is trusted by definition, but it is never counted as auto.",
		"",
	);

	out.push(
		"## Methods",
		"",
		table(
			["method", "agent", "what", "evidence", "estimates", "module"],
			Object.entries(METHODS).map(([id, m]) => [
				`\`${id}\``,
				m.agent,
				m.label,
				m.evidence.join(", "),
				m.estimates.join(", "),
				m.module,
			]),
		),
		"",
	);

	out.push(
		"## Crosswalks",
		"",
		"Each table maps every member of an app union onto the canonical axes, and tsc enforces that the mapping is exhaustive (`satisfies Record<Union, …>`).",
		"",
	);
	for (const [name, where, t] of CROSSWALKS)
		out.push(
			`### ${name}`,
			"",
			`\`${where}\``,
			"",
			table(
				["value", "provenance", "UI"],
				Object.entries(t).map(([k, v]) => [
					`\`${k}\``,
					prov(v),
					"label" in v ? String((v as { label: string }).label) : "",
				]),
			),
			"",
		);
	out.push(
		"### View mode and blend method (UI words)",
		"",
		table(
			["code", "UI", "hint"],
			Object.entries(presentation.VIEW_MODE).map(([k, v]) => [
				`\`${k}\``,
				v.label,
				v.hint,
			]),
		),
		"",
		table(
			["code", "UI"],
			Object.entries(presentation.BLEND_METHOD).map(([k, v]) => [
				`\`${k}\``,
				v.label,
			]),
		),
		"",
		"### Export kinds",
		"",
		table(
			["kind", "concept", "versioned"],
			Object.entries(presentation.EXPORT_KIND).map(([k, v]) => [
				`\`${k}\``,
				`\`${v.concept}\``,
				v.versioned ? "yes" : "no",
			]),
		),
		"",
	);

	out.push(
		"## Confidence scales",
		"",
		"Scores are only comparable within one scale. Levels can be compared across scales: `high` means at or above the producer's own accept threshold.",
		"",
		table(
			[
				"scale",
				"label",
				"calibrated",
				"high ≥",
				"medium ≥",
				"accept rule",
				"module",
			],
			Object.entries(CONFIDENCE_SCALES).map(([id, s]) => [
				`\`${id}\``,
				s.label,
				s.calibrated ? "yes" : "no",
				s.high == null ? "never" : String(s.high),
				String(s.medium),
				s.accept,
				s.module,
			]),
		),
		"",
	);

	out.push("## Resolution policies", "");
	for (const [id, p] of Object.entries(RESOLUTION_POLICIES))
		out.push(
			`### \`${id}\`: ${p.label}`,
			"",
			`${p.purpose}. Implemented by \`${p.implementedBy}\`.`,
			"",
			...p.rules.map((r, i) => `${i + 1}. ${r.label}`),
			"",
		);

	out.push(
		"## Units and frames",
		"",
		"Quantities are soft-branded (`Deg`, `Rad`, `Metres`, `Height<Datum>`, `Px<Basis>`, `Norm`, `Prob`, `Millis`, `Seconds`, `IsoTime`). A plain number is assignable to any of them, but two different units are never assignable to each other.",
		"",
		"Height datums are `msl` (DEM, OSM, GPS), `ellipsoid` (ECEF, Google tiles) and `ground` (above the DEM). The two ENU frames are distinct: `enu-engine` has its origin at (lat, lon, h=0) and z is MSL; `enu-eye` has its origin at the eye.",
		"",
		table(
			["pixel basis", "measured on", "px"],
			Object.entries(PIXEL_BASES).map(([k, v]) => [
				`\`${k}\``,
				v.side,
				String(v.px || "own size"),
			]),
		),
		"",
	);

	out.push(
		"## Identifiers",
		"",
		"A reference is `Ref<C> = {concept, id}`, and its string form is the URN `rigi:<concept>/<id>`. Schemes are tried most-specific first.",
		"",
		table(
			["concept", "kind", "pattern", "example", "stable", "minted by"],
			ID_SCHEMES.map((s) => [
				s.concept,
				s.kind,
				`\`${s.pattern.source}\``,
				`\`${s.example}\``,
				s.stable ? "yes" : "no",
				s.mintedBy + ("note" in s && s.note ? ` (${s.note})` : ""),
			]),
		),
		"",
	);

	out.push(
		"## Storage",
		"",
		"Every key Rigi persists. The check fails on any `rigi.` / `rigi-uploads` / `rigi-tiles-` literal in `src/` that is not registered here.",
		"",
		table(
			["id", "medium", "key", "holds", "version", "module"],
			Object.entries(STORAGE).map(([id, s]) => [
				`\`${id}\``,
				s.medium,
				`\`${s.key}\``,
				s.holds + ("note" in s && s.note ? ` (${s.note})` : ""),
				s.version == null ? "none" : `v${s.version}`,
				s.module,
			]),
		),
		"",
	);

	out.push(
		"## Findings",
		"",
		"These are places where the code disagrees with itself, found by modelling it. `drift` rows that can be measured are pinned by the check.",
		"",
		table(
			["kind", "finding", "where", "action"],
			FINDINGS.map((f) => [f.kind, f.summary, f.where.join("; "), f.action]),
		),
		"",
	);
	return out.join("\n");
}
