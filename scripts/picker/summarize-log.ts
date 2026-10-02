// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Summarise an exported picker log (the panel's "log" download). No network.
//   npx tsx scripts/picker/summarize-log.ts rigi-picker-log-2026-10-02.json [--json]
import { readFileSync } from "node:fs";
import { parsePickerLogText } from "../../src/lib/picker/schema";
import { formatSummary, summarizeLog } from "../../src/lib/picker/summary";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
	console.error(
		"usage: npx tsx scripts/picker/summarize-log.ts <log.json> [--json]",
	);
	process.exit(2);
}
const parsed = parsePickerLogText(readFileSync(file, "utf8"));
if (!parsed) {
	console.error(`${file}: not JSON`);
	process.exit(1);
}
const summary = summarizeLog(parsed.entries);
if (args.includes("--json"))
	console.log(
		JSON.stringify({ ...summary, droppedEntries: parsed.dropped }, null, 1),
	);
else {
	console.log(formatSummary(summary));
	if (parsed.dropped)
		console.log(`dropped ${parsed.dropped} unreadable entries`);
}
