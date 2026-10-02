// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Page flags forwarded to worker realms (core/realm.ts). Node has no `document`, so the flag reader
// behaves like a worker realm: only __RIGI_FLAGS__ overrides count.
import assert from "node:assert/strict";
import {
	FLAG_NAMES,
	FLAG_SCHEMA,
	type FlagName,
	flagSet,
	getFlag,
	setFlagOverride,
} from "#/lib/flags";
import {
	applyRealmGpuOptions,
	FORWARDED_FLAGS,
	realmGpuOptions,
} from "./realm";

const g = globalThis as { __RIGI_FLAGS__?: Record<string, unknown> };
const clear = () => {
	g.__RIGI_FLAGS__ = undefined;
};

clear();
assert.equal(realmGpuOptions(), undefined, "nothing set: undefined");

setFlagOverride("skylineGpu", "on");
assert.deepEqual(realmGpuOptions(), { flags: { skylineGpu: "on" } });
setFlagOverride("gpu", "off");
const sent = realmGpuOptions();
assert.deepEqual(sent?.flags, { gpu: "off", skylineGpu: "on" });

// a flag that is not forwarded never travels
setFlagOverride("renderer", "deck");
assert.deepEqual(realmGpuOptions()?.flags, { gpu: "off", skylineGpu: "on" });

// the receiving realm starts with no overrides
clear();
assert.equal(getFlag("skylineGpu"), "off");
assert.equal(getFlag("gpu"), "on");
applyRealmGpuOptions(sent);
assert.equal(getFlag("skylineGpu"), "on");
assert.equal(getFlag("gpu"), "off");
assert.equal(flagSet("renderer"), false);

// unknown / non-forwarded keys are ignored
clear();
applyRealmGpuOptions({
	flags: { renderer: "deck", nope: "x" } as never,
});
assert.equal(flagSet("renderer"), false);
assert.equal(g.__RIGI_FLAGS__, undefined);

// every allowed value of every forwarded flag survives stringify + parse
for (const name of FORWARDED_FLAGS) {
	const def = FLAG_SCHEMA[name as FlagName];
	assert.equal(def.kind, "enum", `${name} is an enum`);
	for (const value of (def as { values: readonly string[] }).values) {
		clear();
		setFlagOverride(name, value);
		const o = realmGpuOptions();
		assert.equal(o?.flags?.[name], value);
		clear();
		applyRealmGpuOptions(o);
		assert.equal(getFlag(name), value, `${name}=${value}`);
	}
}
assert.ok(FORWARDED_FLAGS.every((n) => FLAG_NAMES.includes(n)));

clear();
console.log("realm-flags: ok");
