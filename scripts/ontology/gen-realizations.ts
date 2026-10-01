// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// npx tsx scripts/ontology/gen-realizations.ts — regenerate the catalogue-derived files:
// src/lib/ontology/checks/realizations.ts and src/lib/ontology/domain.ts (see src/lib/ontology/generate.ts).
import { writeFileSync } from "node:fs";
import {
	renderDomain,
	renderRealizations,
} from "../../src/lib/ontology/generate";

const files = {
	"../../src/lib/ontology/checks/realizations.ts": renderRealizations(),
	"../../src/lib/ontology/domain.ts": renderDomain(),
};
for (const [path, text] of Object.entries(files))
	writeFileSync(new URL(path, import.meta.url), text);
console.log(`wrote ${Object.keys(files).join(", ")}`);
