// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { markSavingFailed } from "../save-status";

describe("markSavingFailed", () => {
	it("fails only the items that are saving now", () => {
		const items = [
			{ key: 1, status: "saving" },
			{ key: 2, status: "saved" },
			{ key: 3, status: "save-error", error: "earlier" },
			{ key: 4, status: "ready" },
		];
		const out = markSavingFailed(items, "quota");
		expect(out.map((i) => i.status)).toEqual(["save-error", "saved", "save-error", "ready"]);
		expect(out[0]).toEqual({ key: 1, status: "save-error", error: "quota" });
		expect(out[2].error).toBe("earlier");
	});
	it("reads current status, not a click-time snapshot", () => {
		const snapshot = [{ key: 1, status: "ready" }];
		const current = [{ key: 1, status: "saving" }];
		expect(snapshot.some((i) => i.status === "saving")).toBe(false);
		expect(markSavingFailed(current, "x")[0].status).toBe("save-error");
	});
	it("keeps untouched items by reference and does not mutate the input", () => {
		const saved = { key: 2, status: "saved" };
		const saving = { key: 1, status: "saving" };
		const out = markSavingFailed([saving, saved], "x");
		expect(out[1]).toBe(saved);
		expect(saving.status).toBe("saving");
	});
});
