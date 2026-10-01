// npx tsx scripts/ontology/doc.ts — regenerate reports/ontology.md from src/lib/ontology.
import { writeFileSync } from "node:fs";
import { renderOntologyDoc } from "../../src/lib/ontology/doc";

const out = new URL("../../reports/ontology.md", import.meta.url);
writeFileSync(out, renderOntologyDoc());
console.log(`wrote ${out.pathname}`);
