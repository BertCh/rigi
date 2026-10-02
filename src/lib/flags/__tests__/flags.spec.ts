// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFlags } from "#/test/helpers";

type Mod = typeof import("../index");
let F: Mod;
let warn: ReturnType<typeof vi.spyOn>;

// the warn-once set is module state: a fresh module per test keeps the cases independent
beforeEach(async () => {
	vi.resetModules();
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	F = await import("../index");
});

describe("FLAG_SCHEMA", () => {
	it("every enum default is one of its values", () => {
		for (const n of F.FLAG_NAMES) {
			const d = F.flagDef(n);
			if (d.kind === "enum") expect(d.values).toContain(d.def);
		}
	});
	it("on/off flags have exactly the two values", () => {
		const d = F.flagDef("gpu");
		expect(d).toEqual({ kind: "enum", values: ["on", "off"], def: "on" });
	});
	it("FLAG_NAMES lists every schema key", () => {
		expect(F.FLAG_NAMES).toEqual(Object.keys(F.FLAG_SCHEMA));
		expect(new Set(F.FLAG_NAMES).size).toBe(F.FLAG_NAMES.length);
	});
	it("every restart flag exists", () => {
		for (const n of F.RESTART_FLAGS) expect(F.FLAG_NAMES).toContain(n);
	});
});

describe("parseFlags", () => {
	it("returns only the flags present in the query", () => {
		expect(F.parseFlags("?gpu=off&other=1")).toEqual({ gpu: "off" });
		expect(F.parseFlags("")).toEqual({});
	});
	it("accepts a query with or without the leading ?", () => {
		expect(F.parseFlags("renderer=deck")).toEqual({ renderer: "deck" });
		expect(F.parseFlags("?renderer=deck")).toEqual({ renderer: "deck" });
	});
	it("lower-cases and trims enum values", () => {
		expect(F.parseFlags("?renderer=%20WebGPU%20")).toEqual({
			renderer: "webgpu",
		});
	});
	it("a bad enum value falls back to the default and warns once", () => {
		expect(F.parseFlags("?gpu=maybe")).toEqual({ gpu: "on" });
		expect(F.parseFlags("?gpu=maybe")).toEqual({ gpu: "on" });
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain("?gpu=maybe is not a valid value");
	});
	it("an empty enum value falls back silently", () => {
		expect(F.parseFlags("?gpu=")).toEqual({ gpu: "on" });
		expect(F.parseFlags("?tiles3d=")).toEqual({ tiles3d: "off" });
	});
	it("an unknown renderer value takes the generic warning and the default", () => {
		expect(F.parseFlags("?renderer=three")).toEqual({ renderer: "auto" });
		expect(warn.mock.calls[0][0]).toContain("is not a valid value");
	});
	it("parses a set flag in schema order, dropping duplicates and unknown members", () => {
		expect(F.parseFlags("?concord=occl,eye")).toEqual({
			concord: ["eye", "occl"],
		});
		expect(F.parseFlags("?concord=eye,eye")).toEqual({ concord: ["eye"] });
		expect(F.parseFlags("?concord=eye,bogus")).toEqual({ concord: ["eye"] });
		expect(warn.mock.calls[0][0]).toContain("?concord=bogus");
		expect(F.parseFlags("?concord=")).toEqual({ concord: [] });
		expect(F.parseFlags("?concord=%20EYE%20,")).toEqual({ concord: ["eye"] });
	});
	it("parses numbers, ignoring blanks and non-finite values", () => {
		expect(F.parseFlags("?tiles3dBias=-12.5")).toEqual({ tiles3dBias: -12.5 });
		expect(F.parseFlags("?tiles3dBias=1e2")).toEqual({ tiles3dBias: 100 });
		expect(F.parseFlags("?tiles3dBias=")).toEqual({ tiles3dBias: undefined });
		expect(F.parseFlags("?tiles3dBias=abc")).toEqual({
			tiles3dBias: undefined,
		});
		expect(F.parseFlags("?tiles3dBias=Infinity")).toEqual({
			tiles3dBias: undefined,
		});
	});
	it("keeps text flags verbatim (trimmed), blank = undefined", () => {
		expect(F.parseFlags("?style=Landeskarte")).toEqual({
			style: "Landeskarte",
		});
		expect(F.parseFlags("?reveal=%20off%20")).toEqual({ reveal: "off" });
		expect(F.parseFlags("?style=")).toEqual({ style: undefined });
	});
	it("ignores unknown params", () => {
		expect(F.parseFlags("?nope=1&Gpu=off")).toEqual({});
	});
});

describe("flagFrom", () => {
	it("returns the default when the param is absent, without warning", () => {
		expect(F.flagFrom("?x=1", "renderer")).toBe("auto");
		expect(F.flagFrom("", "concord")).toEqual([]);
		expect(F.flagFrom("", "tiles3dBias")).toBeUndefined();
		expect(warn).not.toHaveBeenCalled();
	});
	it("parses the present value", () => {
		expect(F.flagFrom("?renderer=deck", "renderer")).toBe("deck");
	});
});

describe("getFlag / overrides", () => {
	it("defaults when nothing is set (node has no page URL)", () => {
		expect(F.getFlag("renderer")).toBe("auto");
		expect(F.getFlag("skylineGpu")).toBe("off");
		expect(F.getFlag("colorTarget")).toBe("rgba16");
		expect(F.flagSet("renderer")).toBe(false);
	});
	it("reads the per-realm override live", () => {
		withFlags({ gpu: "off" });
		expect(F.getFlag("gpu")).toBe("off");
		expect(F.flagSet("gpu")).toBe(true);
		expect(F.flagOverride("gpu")).toBe("off");
		delete (globalThis as { __RIGI_FLAGS__?: unknown }).__RIGI_FLAGS__;
		expect(F.getFlag("gpu")).toBe("on");
	});
	it("validates overrides like URL values", () => {
		withFlags({ gpu: "OFF", renderer: "three", tiles3d: "nonsense" });
		expect(F.getFlag("gpu")).toBe("off");
		expect(F.getFlag("renderer")).toBe("auto");
		expect(F.getFlag("tiles3d")).toBe("off");
	});
	it("accepts non-string override values (numbers, arrays)", () => {
		(globalThis as { __RIGI_FLAGS__?: unknown }).__RIGI_FLAGS__ = {
			tiles3dBias: 7,
			concord: ["eye", "occl"],
		};
		expect(F.getFlag("tiles3dBias")).toBe(7);
		expect(F.getFlag("concord")).toEqual(["eye", "occl"]);
	});
	it("an undefined override entry falls through to the default", () => {
		(globalThis as { __RIGI_FLAGS__?: unknown }).__RIGI_FLAGS__ = {
			gpu: undefined,
		};
		expect(F.getFlag("gpu")).toBe("on");
		expect(F.flagSet("gpu")).toBe(false);
		expect(F.flagOverride("gpu")).toBeUndefined();
	});
	it("setFlagOverride creates, sets and removes", () => {
		F.setFlagOverride("gpu", "off");
		expect(F.getFlag("gpu")).toBe("off");
		F.setFlagOverride("skylineGpu", "on");
		F.setFlagOverride("gpu", undefined);
		expect(F.getFlag("gpu")).toBe("on");
		expect(F.getFlag("skylineGpu")).toBe("on");
	});
});

describe("flagSearch", () => {
	it("keeps only known flag names with primitive values", () => {
		expect(
			F.flagSearch({
				gpu: "off",
				tiles3dBias: 3,
				share: true,
				bogus: "x",
				renderer: { a: 1 },
				style: null,
				theme: undefined,
			}),
		).toEqual({ gpu: "off", tiles3dBias: 3, share: true });
	});
	it("returns an empty object for empty input", () => {
		expect(F.flagSearch({})).toEqual({});
	});
});

describe("flagSearchValue", () => {
	it("drops enum values equal to the default, keeps others as strings", () => {
		expect(F.flagSearchValue("gpu", "on")).toBeUndefined();
		expect(F.flagSearchValue("gpu", "off")).toBe("off");
		expect(F.flagSearchValue("renderer", undefined)).toBeUndefined();
	});
	it("joins set values and drops the empty set", () => {
		expect(F.flagSearchValue("concord", ["eye", "occl"])).toBe("eye,occl");
		expect(F.flagSearchValue("concord", "eye")).toBe("eye");
		expect(F.flagSearchValue("concord", [])).toBeUndefined();
	});
	it("coerces numbers and drops blanks / non-finite", () => {
		expect(F.flagSearchValue("tiles3dBias", 5)).toBe(5);
		expect(F.flagSearchValue("tiles3dBias", "2.5")).toBe(2.5);
		expect(F.flagSearchValue("tiles3dBias", "")).toBeUndefined();
		expect(F.flagSearchValue("tiles3dBias", "abc")).toBeUndefined();
		expect(F.flagSearchValue("tiles3dBias", Number.NaN)).toBeUndefined();
		expect(F.flagSearchValue("tiles3dBias", 0)).toBe(0);
	});
	it("keeps text and drops blank text", () => {
		expect(F.flagSearchValue("style", "swiss")).toBe("swiss");
		expect(F.flagSearchValue("style", "")).toBeUndefined();
	});
});

describe("flagsKey", () => {
	it("is empty when no restart flag is present", () => {
		expect(F.flagsKey("")).toBe("");
		expect(F.flagsKey("?theme=dark&style=x&skylineGpu=on")).toBe("");
	});
	it("lists restart flags in RESTART_FLAGS order, not query order", () => {
		expect(F.flagsKey("?tiles3d=google&renderer=deck")).toBe(
			"renderer=deck&tiles3d=google",
		);
	});
	it("canonicalises values so spelling variants share a key", () => {
		expect(F.flagsKey("?renderer=DECK")).toBe(F.flagsKey("?renderer=deck"));
		expect(F.flagsKey("?concord=occl,eye")).toBe("concord=eye,occl");
	});
	it("uses the fallback value for a bad restart flag", () => {
		expect(F.flagsKey("?renderer=three")).toBe("renderer=auto");
	});
	it("changes with a live flag only when it is a restart flag", () => {
		expect(F.flagsKey("?gpu=off")).not.toBe(F.flagsKey("?gpu=on"));
		expect(F.flagsKey("?skylineGpu=off")).toBe(F.flagsKey("?skylineGpu=on"));
	});
});
