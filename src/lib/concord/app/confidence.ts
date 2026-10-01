// Pose confidence for the concord display pass (moved from the removed field/fit.ts, 2026-09-30).
// Fail closed: anything not explicitly accepted with enough confidence is LOW.

export type PoseConfidence = {
	accepted?: boolean;
	confidence?: number;
	level?: "high" | "medium" | "low";
};

/** Below this solve confidence the pose is LOW (solve.ts acceptConfidence default). */
export const MIN_CONFIDENCE = 0.5;

/** LOW unless the pose is explicitly accepted with confidence ≥ MIN_CONFIDENCE (fail closed). */
export function isLowConfidence(c: PoseConfidence | null | undefined): boolean {
	if (!c) return true;
	if (c.level === "low") return true;
	if (c.accepted === false) return true;
	if (c.level === "high" || c.level === "medium")
		return c.confidence === undefined
			? c.accepted !== true
			: !(c.confidence >= MIN_CONFIDENCE);
	return !(typeof c.confidence === "number" && c.confidence >= MIN_CONFIDENCE);
}
