// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Builds the self-contained static verification page for one verifier and one batch. Neutral by construction:
 * the only per-item data embedded is the hashed folder, the overlay label and the image paths (no pose, id or source).
 */
import type { SessionItem } from "./lib";

export interface SessionPage {
	verifier: string;
	batch: number | null;
	items: SessionItem[];
	/** Path from the HTML file to the pack directory, with trailing slash. */
	packUrl: string;
}

const esc = (s: string) =>
	s.replace(
		/[&<>"]/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
	);

export function renderSessionHtml(p: SessionPage): string {
	const data = JSON.stringify({
		verifier: p.verifier,
		batch: p.batch,
		items: p.items,
		packUrl: p.packUrl,
	}).replace(/</g, "\\u003c");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verification ${esc(p.verifier)}</title>
<style>
body{font:15px system-ui,sans-serif;margin:0;background:#16181d;color:#e6e6e6}
header{display:flex;gap:16px;align-items:center;padding:8px 16px;background:#20232b;position:sticky;top:0}
main{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:8px}
main img{width:100%;height:auto;background:#000}
h4{margin:0 0 4px;font-weight:600;color:#9aa}
.bar{padding:8px 16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
button{font:inherit;padding:6px 12px;border:1px solid #556;background:#2a2e38;color:inherit;border-radius:4px;cursor:pointer}
button.on{background:#3b6;color:#000}
label.chk{display:flex;gap:4px;align-items:center}
textarea{width:320px;background:#111;color:inherit;border:1px solid #445}
small{color:#9aa}
</style></head><body>
<header><b id="who"></b><span id="pos"></span><span id="done"></span>
<button id="prev">&larr; prev (j)</button><button id="next">next (k) &rarr;</button>
<button id="save">Download verdicts.json</button><button id="load">Resume from file</button><input type="file" id="file" accept=".json" hidden></header>
<div class="bar"><small>Checklist (tick what holds): </small>
<label class="chk"><input type="checkbox" data-c="C1"> C1 coverage &ge; 70%</label>
<label class="chk"><input type="checkbox" data-c="C2"> C2 vertical fit within 1.5% of height</label>
<label class="chk"><input type="checkbox" data-c="C3"> C3 feature alignment</label>
<label class="chk"><input type="checkbox" data-c="C4"> C4 tilt</label>
<small>Near miss = wrong. Unsure only for unjudgeable skylines.</small></div>
<div class="bar" id="vb">
<button data-v="correct">correct (c)</button><button data-v="wrong">wrong (w)</button>
<button data-v="near-miss">near-miss = wrong (n)</button><button data-v="unsure">unsure (u)</button><button data-v="not-seen">not seen (x)</button>
<textarea id="note" placeholder="note (optional)" rows="1"></textarea></div>
<main><div><h4>Photo</h4><img id="photo" alt=""></div><div><h4>Candidate overlay</h4><img id="overlay" alt=""></div></main>
<script>
const S = ${data};
const KEY = "h1-verdicts:" + S.verifier + ":" + S.batch;
const started = new Date().toISOString();
let V = {}; try { V = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) {}
let i = 0;
const $ = (id) => document.getElementById(id);
const cur = () => S.items[i];
const rec = () => (V[cur().folder] || {})[cur().label];
function persist() { try { localStorage.setItem(KEY, JSON.stringify(V)); } catch (e) {} }
function show() {
  const it = cur();
  $("who").textContent = "Verifier " + S.verifier;
  $("pos").textContent = "Item " + (i + 1) + " of " + S.items.length;
  const n = S.items.filter((x) => (V[x.folder] || {})[x.label]).length;
  $("done").textContent = n + " recorded";
  $("photo").src = S.packUrl + it.photo; $("overlay").src = S.packUrl + it.overlay;
  const r = rec();
  document.querySelectorAll("#vb button").forEach((b) => b.classList.toggle("on", !!r && r.verdict === b.dataset.v));
  document.querySelectorAll("[data-c]").forEach((c) => { c.checked = !!(r && r.checks && r.checks[c.dataset.c]); });
  $("note").value = (r && r.note) || "";
}
function checks() { const o = {}; document.querySelectorAll("[data-c]").forEach((c) => { o[c.dataset.c] = c.checked; }); return o; }
function set(v) {
  const it = cur(); (V[it.folder] = V[it.folder] || {})[it.label] = { verdict: v, checks: checks(), note: $("note").value, ts: new Date().toISOString() };
  persist(); if (i < S.items.length - 1) i++; show();
}
function go(d) { i = Math.max(0, Math.min(S.items.length - 1, i + d)); show(); }
document.querySelectorAll("#vb button").forEach((b) => b.addEventListener("click", () => set(b.dataset.v)));
$("prev").onclick = () => go(-1); $("next").onclick = () => go(1);
$("save").onclick = () => {
  const out = { schema: "h1-verdicts/1", verifier: S.verifier, batch: S.batch, startedAt: started, savedAt: new Date().toISOString(), verdicts: V };
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: "application/json" }));
  a.download = "verdicts_" + S.verifier + (S.batch === null ? "" : "_b" + S.batch) + ".json"; a.click();
};
$("load").onclick = () => $("file").click();
$("file").onchange = async (e) => { const f = e.target.files[0]; if (!f) return; const j = JSON.parse(await f.text()); if (j.schema === "h1-verdicts/1" && j.verifier === S.verifier) { V = j.verdicts; persist(); show(); } else alert("not a verdicts file for verifier " + S.verifier); };
addEventListener("keydown", (e) => {
  if (e.target.tagName === "TEXTAREA") return;
  const m = { c: "correct", w: "wrong", n: "near-miss", u: "unsure", x: "not-seen" };
  if (m[e.key]) set(m[e.key]); else if (e.key === "j") go(-1); else if (e.key === "k") go(1);
});
show();
</script></body></html>
`;
}
