// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// StepCamera's window key bindings (1–4 switch mode): they must not steal keys typed into a text field.
import { Quaternion } from "@math.gl/core";
import { afterEach, describe, expect, it } from "vitest";
import { ViewCamera } from "../../camera/view-camera";
import { StepCamera } from "../step-camera";

const cams: StepCamera[] = [];
afterEach(() => {
	for (const c of cams.splice(0)) c.dispose();
	document.body.innerHTML = "";
});

function make() {
	const dom = document.createElement("div");
	document.body.append(dom);
	const sc = new StepCamera(new ViewCamera(50, 4 / 3), dom, {
		eye: [0, 0, 100],
		quaternion: new Quaternion(),
		vfov: 40,
		aspect: 4 / 3,
		radius: 40,
	});
	cams.push(sc);
	return sc;
}

function press(target: EventTarget, key: string) {
	target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("StepCamera keys", () => {
	it("switches mode on 2 from the page", () => {
		const sc = make();
		press(document.body, "2");
		expect(sc.mode).toBe("orbit");
	});

	it("ignores keys typed into an input or a contenteditable element", () => {
		const sc = make();
		const input = document.createElement("input");
		const editable = document.createElement("div");
		editable.contentEditable = "true";
		document.body.append(input, editable);
		press(input, "2");
		expect(sc.mode).toBe("photo");
		press(editable, "3");
		expect(sc.mode).toBe("photo");
	});
});
