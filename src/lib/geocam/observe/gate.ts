// GA2 eye gate: guard-rail §4.1 of reports/geometry-first-pose.md. The eye may move only if
//   1. it is observable: the CRLB σ_eye (horizontal, √λmax of Σ_EN) < maxSigmaEyeM (default 15 m);
//   2. a held-out cue family that was NOT used in the fit confirms the move (heldOutFamily.improved), and
//      that fit lands near the full one (agreeM ≤ max(maxAgreeM, the move / 2));
//   3. the GA5 protection level passes (integrity.pass). Not evaluated ⇒ the gate stays shut.
// Fails closed: any missing input is a reason.
import type { FisherReport } from "./fisher";
import type { HeldOut } from "./heldout";

export type GateOpts = {
	maxSigmaEyeM?: number;
	/** Agreement of the held-out fit with the full fit (m). Default 15. */
	maxAgreeM?: number;
	/** GA5 result (integrity/protectionLevel); undefined ⇒ not evaluated ⇒ refuse. */
	integrity?: { pass: boolean } | null;
};

export type GateResult = { ok: boolean; reasons: string[] };

export function eyeMayMove(
	fr: FisherReport,
	held: HeldOut[],
	o: GateOpts = {},
): GateResult {
	const maxS = o.maxSigmaEyeM ?? 15;
	const maxAgree = o.maxAgreeM ?? 15;
	const reasons: string[] = [];
	if (!(fr.sigmaEye < maxS))
		reasons.push(
			`eye not observable: σ_eye ${fr.sigmaEye.toFixed(1)} m ≥ ${maxS} m`,
		);
	const confirm = held.filter(
		(h) => h.improved && h.agreeM <= Math.max(maxAgree, h.eyeMoveM / 2),
	);
	if (!held.length) reasons.push("no held-out family tested");
	else if (!confirm.length)
		reasons.push(
			`no held-out family confirms the move (${held.map((h) => `${h.family} ${h.before.toFixed(2)}→${h.after.toFixed(2)}${h.improved ? ` agree ${h.agreeM.toFixed(0)} m` : ""}`).join(", ")})`,
		);
	if (!o.integrity) reasons.push("GA5 protection level not evaluated");
	else if (!o.integrity.pass) reasons.push("GA5 protection level fails");
	return { ok: reasons.length === 0, reasons };
}
