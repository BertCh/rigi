// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Share-link beta (roadmap L1): a photo reference plus an endorsed pose, packed into a short,
// URL-safe code for the read-only /s/$code route. Behind ?share=on until the N2 licence review
// clears. Only bundled demo photos are shareable: uploads live on the sender's device and nothing
// hosts them. Only accepted or user-endorsed poses travel (precision over recall).
// Design: reports/share-beta-design-2026-10-02.md.
import type { Pose } from "#/lib/camera";
import type { Assert } from "#/lib/ontology/core/assert";
import type { AlignState } from "#/lib/ontology/crosswalk/pose";

export const SHARE_VERSION = 1;

/** Align states whose status is accepted or endorsed (src/lib/ontology/crosswalk/pose.ts). */
export const SHAREABLE_STATES = [
	"accepted",
	"manual",
	"pinned",
	"saved",
] as const;
export type ShareableState = (typeof SHAREABLE_STATES)[number];
export type _shareableIsAlignState = Assert<
	ShareableState extends AlignState ? true : false
>;

export interface SharePayload {
	v: typeof SHARE_VERSION;
	photo: { kind: "demo"; id: string };
	pose: Pose;
	state: ShareableState;
}

const DEMO_ID = /^demo-\d{2}$/;

export type ShareCheck = { ok: true } | { ok: false; reason: string };

export const SHARE_REASON_LOCAL =
	"Sharing your own photos needs hosting, which the beta does not have yet. Your photo stays on this device.";
export const SHARE_REASON_STATE =
	"Only an accepted or confirmed alignment can be shared.";

export function isShareableState(
	state: string | null | undefined,
): state is ShareableState {
	return (SHAREABLE_STATES as readonly string[]).includes(state ?? "");
}

/** Whether this photo and align state may be shared, with a one-line reason when not. */
export function canShare(
	photoId: string,
	state: AlignState | null | undefined,
): ShareCheck {
	if (!DEMO_ID.test(photoId)) return { ok: false, reason: SHARE_REASON_LOCAL };
	if (!isShareableState(state))
		return { ok: false, reason: SHARE_REASON_STATE };
	return { ok: true };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const wrap360 = (x: number) => round2(((x % 360) + 360) % 360) % 360;
/** Compact decimal: no trailing zeros, no "-0". */
const num = (x: number) => String(Object.is(x, -0) ? 0 : x);

function normalisePose(p: Pose): Pose | null {
	const { yaw, pitch, roll, vfov } = p;
	if (![yaw, pitch, roll, vfov].every(Number.isFinite)) return null;
	const out = {
		yaw: wrap360(yaw),
		pitch: round2(pitch),
		roll: round2(roll),
		vfov: round2(vfov),
	};
	if (Math.abs(out.pitch) > 90 || Math.abs(out.roll) > 90) return null;
	if (!(out.vfov > 1 && out.vfov < 170)) return null;
	return out;
}

/**
 * `1~demo-09~<yaw>~<pitch>~<roll>~<vfov>~<state>`, angles in degrees to 0.01. "." would be
 * ambiguous with decimals, so the separator is "~" (an unreserved URL character).
 */
const SEP = "~";

export function encodeShare(payload: SharePayload): string {
	const pose = normalisePose(payload.pose);
	// encoding is only ever called on a payload that passed canShare; an invalid pose is a caller bug
	if (!pose || !DEMO_ID.test(payload.photo.id))
		throw new Error("invalid share payload");
	return [
		SHARE_VERSION,
		payload.photo.id,
		num(pose.yaw),
		num(pose.pitch),
		num(pose.roll),
		num(pose.vfov),
		payload.state,
	].join(SEP);
}

const NUMBER = /^-?\d+(\.\d+)?$/;

/** The payload in a share code, or null for anything that is not a valid v1 code. Never throws. */
export function decodeShare(
	code: string | null | undefined,
): SharePayload | null {
	if (typeof code !== "string" || code.length > 128) return null;
	let text: string;
	try {
		text = decodeURIComponent(code);
	} catch {
		return null;
	}
	const parts = text.split(SEP);
	if (parts.length !== 7) return null;
	const [v, id, ...rest] = parts;
	const state = rest.pop();
	if (v !== String(SHARE_VERSION) || !DEMO_ID.test(id)) return null;
	if (!isShareableState(state)) return null;
	if (!rest.every((s) => NUMBER.test(s))) return null;
	const [yaw, pitch, roll, vfov] = rest.map(Number);
	const pose = normalisePose({ yaw, pitch, roll, vfov });
	if (!pose) return null;
	return { v: SHARE_VERSION, photo: { kind: "demo", id }, pose, state };
}

/** The read-only share URL; carries ?share=on while the beta is gated. */
export function shareUrl(origin: string, payload: SharePayload): string {
	return `${origin.replace(/\/+$/, "")}/s/${encodeShare(payload)}?share=on`;
}

/** The display-only mark on shared renders and their exports. */
export const SHARE_WATERMARK = "Rigi · shared view";
