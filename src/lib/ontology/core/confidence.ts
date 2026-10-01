// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// L3: confidence, scale-aware. Each producer scores on its OWN scale with its own accept rule; scores from
// different scales are never compared. What IS comparable is the level, read through the scale.

export type ConfidenceLevel = "high" | "medium" | "low" | "unknown";

export type ConfidenceScale = {
	readonly label: string;
	/** true only if scores were checked to behave like probabilities */
	readonly calibrated: boolean;
	/**
	 * score ≥ high → "high"; ≥ medium → "medium"; else "low"; null score → "unknown".
	 * `high` is the producer's own ACCEPT threshold (null: this producer alone never makes a pose HIGH);
	 * `medium` its softer "show it" threshold (= high when it has none).
	 */
	readonly high: number | null;
	readonly medium: number;
	/** the producer's own accept rule, in words, with the code that applies it */
	readonly accept: string;
	readonly module: string;
	/** level-only producers: the score is an encoding of a level, not a measurement */
	readonly levelOnly?: boolean;
	/** the "medium" bar is strict (score > medium), as the producer's code compares */
	readonly mediumExclusive?: boolean;
};

/**
 * Producers of a confidence number. Thresholds mirror the code; ontology.check.ts verifies the ones
 * that are exported constants (AGREE_DEG etc. are angles, not scores, and live in the methods).
 */
export const CONFIDENCE_SCALES = {
	"skyline-align": {
		label: "autoAlign confidence",
		calibrated: false,
		high: null,
		medium: 0.2,
		mediumExclusive: true,
		accept:
			"> 0.2 shows it as the auto pose (second-opinion.ts choosePreview); never HIGH alone (43 % wild precision)",
		module: "lib/align.ts",
	},
	cascade: {
		label: "unknown-pose cascade",
		calibrated: false,
		high: 0.5,
		medium: 0.5,
		accept:
			"accepted && !ambiguous && !weak360; the bar rises to 0.75 when focal or yaw is unknown (unknown-pose.worker.ts)",
		module: "lib/integration/unknown-pose.ts",
	},
	refine: {
		label: "refine score (product of six ramps)",
		calibrated: false,
		high: 0.5,
		medium: 0.5,
		accept: "score ≥ 0.5 && !hardFail (refine/confidence.ts)",
		module: "lib/refine/confidence.ts",
	},
	matcher: {
		label: "matcher level (0.9 = HIGH, 0.2 = LOW)",
		calibrated: false,
		high: 0.9,
		medium: 0.9,
		accept:
			"HIGH && (position trusted || cascade within MATCH_AGREE_DEG) (matcher-client.ts matchAccepted)",
		module: "lib/matcher-client.ts",
		levelOnly: true,
	},
	"matcher-v01": {
		label:
			"matcher v0.1 render-match heuristic (no confidenceLevel on the response)",
		calibrated: false,
		high: 0.5,
		medium: 0.5,
		accept:
			"confidence ≥ 0.5 counts as the service's HIGH (matcher-client.ts matchIsConfident)",
		module: "lib/matcher-client.ts",
	},
	concord: {
		label: "concordance display confidence",
		calibrated: false,
		high: 0.5,
		medium: 0.5,
		accept: "fail closed below 0.5 (concord/app MIN_CONFIDENCE)",
		module: "lib/concord/app/confidence.ts",
	},
	roll: {
		label: "roll solved-pose confidence (the cascade's)",
		calibrated: false,
		high: 0.5,
		medium: 0.5,
		accept:
			"only accepted poses are stored; propagated suggestions store 0 (never HIGH)",
		module: "lib/roll/align/align.ts",
	},
} as const satisfies Record<string, ConfidenceScale>;
export type ConfidenceScaleId = keyof typeof CONFIDENCE_SCALES;

export type Confidence = {
	/** the producer's score on its own scale; null for level-only or unknown */
	score: number | null;
	scale: ConfidenceScaleId;
	level: ConfidenceLevel;
};

export function levelOf(
	scale: ConfidenceScaleId,
	score: number | null | undefined,
): ConfidenceLevel {
	if (score == null || !Number.isFinite(score)) return "unknown";
	const s = CONFIDENCE_SCALES[scale];
	if (s.high != null && score >= s.high) return "high";
	const medium = "mediumExclusive" in s && s.mediumExclusive;
	if (medium ? score > s.medium : score >= s.medium) return "medium";
	return "low";
}

export const confidence = (
	scale: ConfidenceScaleId,
	score: number | null | undefined,
): Confidence => ({
	score: score ?? null,
	scale,
	level: levelOf(scale, score),
});

const RANK: Record<ConfidenceLevel, number> = {
	unknown: 0,
	low: 1,
	medium: 2,
	high: 3,
};
/** Compare by level only (the one cross-scale comparison that is meaningful). */
export const compareLevel = (a: ConfidenceLevel, b: ConfidenceLevel) =>
	RANK[a] - RANK[b];
