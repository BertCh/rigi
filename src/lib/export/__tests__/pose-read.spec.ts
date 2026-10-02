// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { ALIGN_STATE } from "#/lib/ontology/crosswalk/pose";
import { expectArrayClose } from "#/test/helpers";
import {
	buildCameraModel,
	type CameraInput,
	isTrustedEstimate,
	type PoseEstimateNote,
} from "../camera";
import { buildPoseJson, readPoseJson } from "../pose-json";
import { buildXmp } from "../xmp";
import { FIXTURE, parseXml, SOUTH } from "./fixtures";

const ACCEPTED: PoseEstimateNote = {
	provenance: ALIGN_STATE.accepted,
	label: "Accepted",
	confidence: 0.83,
	sigmaDeg: { yaw: 0.12, pitch: 0.05 },
};
const PRIOR: PoseEstimateNote = {
	provenance: ALIGN_STATE.prior,
	label: "Phone sensors",
};

const fileText = (input: CameraInput) =>
	JSON.stringify(
		buildPoseJson(input, { exportedAt: "2026-10-02T00:00:00.000Z" }),
	);

describe("isTrustedEstimate", () => {
	it("trusts a person's pose and a strict automatic accept, nothing else", () => {
		expect(isTrustedEstimate(ACCEPTED)).toBe(true);
		expect(isTrustedEstimate({ provenance: ALIGN_STATE.saved })).toBe(true);
		expect(isTrustedEstimate({ provenance: ALIGN_STATE.pinned })).toBe(true);
		expect(isTrustedEstimate(PRIOR)).toBe(false);
		expect(isTrustedEstimate({ provenance: ALIGN_STATE.auto })).toBe(false);
		expect(isTrustedEstimate({ provenance: ALIGN_STATE.unverified })).toBe(
			false,
		);
		expect(isTrustedEstimate(null)).toBe(false);
		expect(isTrustedEstimate(undefined)).toBe(false);
	});
});

describe("buildPoseJson estimate block", () => {
	it("is null when the exporter did not say how the pose is known", () => {
		expect(buildPoseJson(FIXTURE).estimate).toBeNull();
	});
	it("records provenance, label, confidence and sigma", () => {
		const e = buildPoseJson({ ...FIXTURE, estimate: ACCEPTED }).estimate;
		expect(e).toEqual({
			trusted: true,
			label: "Accepted",
			status: "accepted",
			agent: "solver",
			method: null,
			role: null,
			outcome: null,
			level: "high",
			corroborated: null,
			confidence: 0.83,
			sigmaDeg: { yaw: 0.12, pitch: 0.05 },
		});
	});
	it("marks a compass prior as not trusted", () => {
		const e = buildPoseJson({ ...FIXTURE, estimate: PRIOR }).estimate;
		expect(e?.trusted).toBe(false);
		expect(e?.method).toBe("exif-prior");
		expect(e?.role).toBe("prior");
	});
	it("drops non-finite or negative sigmas", () => {
		const e = buildPoseJson({
			...FIXTURE,
			estimate: {
				...PRIOR,
				sigmaDeg: { yaw: Number.NaN, roll: -1 },
			},
		}).estimate;
		expect(e?.sigmaDeg).toBeNull();
	});
});

describe("readPoseJson", () => {
	for (const [name, input] of [
		["Niederhorn", FIXTURE],
		["southern hemisphere, no geoid", SOUTH],
	] as const) {
		it(`round trips the camera (${name})`, () => {
			const r = readPoseJson(fileText(input));
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			const a = buildCameraModel(input);
			const b = buildCameraModel(r.input);
			expect(b.width).toBe(a.width);
			expect(b.height).toBe(a.height);
			expect(b.lat).toBeCloseTo(a.lat, 9);
			expect(b.lon).toBeCloseTo(a.lon, 9);
			expect(b.altMsl).toBeCloseTo(a.altMsl, 3);
			expect(b.f).toBeCloseTo(a.f, 3);
			expectArrayClose(b.R_cam2ecef, a.R_cam2ecef, 1e-7);
			expectArrayClose(b.C_ecef, a.C_ecef, 1e-3);
			expect(r.input.takenAt).toBe(input.takenAt ?? null);
			expect(r.input.demAtCamera).toBe(input.demAtCamera ?? null);
			expect(r.json.estimate).toBeNull();
			expect(r.input.estimate).toBeUndefined();
		});
	}
	it("accepts a parsed object as well as text", () => {
		expect(readPoseJson(JSON.parse(fileText(FIXTURE))).ok).toBe(true);
	});
	it("returns the file's provenance as an untrusted claim", () => {
		const r = readPoseJson(fileText({ ...FIXTURE, estimate: ACCEPTED }));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		// only the provenance axes travel (ALIGN_STATE rows also carry UI label/hint words)
		expect(r.claimed).toEqual({
			...ACCEPTED,
			provenance: { agent: "solver", status: "accepted", level: "high" },
		});
		expect(r.input.estimate).toBeUndefined();
		expect(r.json.estimate?.status).toBe("accepted");
		expect(r.json.estimate?.trusted).toBe(false);
	});
	it("reads a v1 file from before the estimate block existed", () => {
		const old = JSON.parse(fileText(FIXTURE));
		delete old.estimate;
		const r = readPoseJson(old);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.json.estimate).toBeNull();
			expect(r.claimed).toBeNull();
		}
	});
	it("never reports a file's pose as trusted, whatever it claims", () => {
		for (const estimate of [
			{ status: "endorsed", trusted: true },
			{ status: "accepted", method: "cascade", level: "high", trusted: true },
		]) {
			const j = JSON.parse(fileText(FIXTURE));
			j.estimate = estimate;
			const r = readPoseJson(j);
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.json.estimate?.trusted).toBe(false);
		}
	});
	it("re-derives the returned file: extra or stale fields do not survive", () => {
		const j = JSON.parse(fileText(FIXTURE));
		j.evil = 1;
		j.orientation.hfov = 5;
		j.position.lat = 0;
		const r = readPoseJson(j);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const fresh = buildPoseJson(FIXTURE, {
			exportedAt: "2026-10-02T00:00:00.000Z",
		});
		expect("evil" in r.json).toBe(false);
		expect(r.json.orientation.hfov).toBeCloseTo(fresh.orientation.hfov, 5);
		expect(r.json.position.lat).toBeCloseTo(fresh.position.lat, 9);
		expect(r.json.exportedAt).toBe("2026-10-02T00:00:00.000Z");
	});

	// biome-ignore lint/suspicious/noExplicitAny: the cases mutate parsed JSON freely
	const broken: [string, (j: Record<string, any>) => void, RegExp][] = [
		["another schema", (j) => (j.schema = "other/pose"), /schema/],
		["a future version", (j) => (j.version = 2), /version 2/],
		["a missing block", (j) => delete j.orientation, /missing/],
		["a NaN yaw (null in JSON)", (j) => (j.orientation.yaw = null), /pose/],
		["a 180° lens sentinel", (j) => (j.orientation.vfov = 180), /pose/],
		["a zero width", (j) => (j.photo.width = 0), /size/],
		["a two-component eye", (j) => (j.extrinsics.enuFrame.eye = [0, 0]), /eye/],
		[
			"a latitude past the pole",
			(j) => (j.extrinsics.enuFrame.lat = 95),
			/frame/,
		],
		["an fx edited without the vfov", (j) => (j.intrinsics.fx *= 1.01), /fx/],
		[
			"a yaw edited without its rotation",
			(j) => (j.orientation.yaw += 5),
			/disagree/,
		],
		[
			"an unknown provenance word",
			(j) => (j.estimate = { status: "sure" }),
			/estimate/,
		],
		[
			"a negative sigma",
			(j) => (j.estimate = { status: "accepted", sigmaDeg: { yaw: -1 } }),
			/estimate/,
		],
		[
			"an unknown sigma key",
			(j) => (j.estimate = { sigmaDeg: { focal: 1 } }),
			/estimate/,
		],
	];
	for (const [what, mutate, error] of broken)
		it(`rejects ${what}`, () => {
			const j = JSON.parse(fileText(FIXTURE));
			mutate(j);
			const r = readPoseJson(j);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toMatch(error);
		});
	it("rejects text that is not JSON or not an object", () => {
		expect(readPoseJson("{").ok).toBe(false);
		expect(readPoseJson("[1,2]").ok).toBe(false);
		expect(readPoseJson(null).ok).toBe(false);
	});
});

describe("buildXmp estimate", () => {
	const attrs = (xml: string): Record<string, string> =>
		parseXml(xml).attrs.find((a) => a._tag === "rdf:Description") ?? {};
	it("writes nothing about provenance when it is unknown", () => {
		const xml = buildXmp(FIXTURE);
		expect(xml).not.toMatch(/rigi:Pose(Trusted|Status|Method|Label)/);
	});
	it("writes trusted, status, label and confidence", () => {
		const a = attrs(buildXmp({ ...FIXTURE, estimate: ACCEPTED }));
		expect(a["rigi:PoseTrusted"]).toBe("True");
		expect(a["rigi:PoseStatus"]).toBe("accepted");
		expect(a["rigi:PoseLabel"]).toBe("Accepted");
		expect(a["rigi:PoseConfidence"]).toBe("0.83");
	});
	it("marks a prior untrusted and escapes the label", () => {
		const xml = buildXmp({
			...FIXTURE,
			estimate: { ...PRIOR, label: 'Phone "sensors" & co' },
		});
		const a = attrs(xml);
		expect(a["rigi:PoseTrusted"]).toBe("False");
		expect(a["rigi:PoseMethod"]).toBe("exif-prior");
		expect(xml).toContain("Phone &quot;sensors&quot; &amp; co");
	});
});
