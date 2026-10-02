# Lensman lore and design motifs for Rigi (subtle nods)

Scope: research only, no repo edits. Sources: web search plus Wikipedia (Lensman series), Project Gutenberg listings. Items marked (memory) are from general knowledge of the books and were not re-verified online; treat as hedged.

## 1. Lore cheat-sheet

Publication (E. E. "Doc" Smith; serialised mostly in Astounding, ed. John W. Campbell; book editions 1948-1954 per Wikipedia):
- Triplanetary (serial 1934), Galactic Patrol (1937-38), Gray Lensman (1939-40), Second Stage Lensmen (1941-42), Children of the Lens (1947-48), First Lensman (book, 1950) (dates: memory).

| Element | What it is | 
|---|---|
| The Lens | Wrist-worn, pseudo-living crystalline jewel; shows shifting "polychromatic" light only while on its owner's wrist; telepathic and a universal translator; attuned to one wearer, kills any other who wears it (Wikipedia: "will kill any other wearer"); dark/dead when its owner dies. Issued by Arisia (via Mentor) to Virgil Samms, then to graduating Galactic Patrol Lensmen. |
| Arisia | Ancient planet of the Arisians, mental-power race. Hidden from the galaxy behind a hypnotic "screen" so visitors misperceive it (memory). Arisians watch and breed bloodlines over millennia towards a planned outcome (Kinnison and Clarrissa MacDougall as "penultimate products", per Wikipedia summary). |
| Mentor of Arisia | The Arisian guide/patron figure; gives Kinnison "second stage" treatment that expands and organises the mind (Wikipedia). Presents himself to visitors as a "Visualization" (memory: "Visualization of the Cosmic All"). |
| Eddore / Eddorians | Hostile power from another space-time continuum, hierarchical, physically brutal; e.g. Gharlane of Eddore (Nero, Gray Roger...). Arisia's opposite. |
| Boskone | The Eddorian-run network of organised crime, piracy and domination that Civilization opposes. |
| Galactic Patrol | Peacekeeping force founded by Virgil Samms to unite species; Lensmen are its elite. |
| Kimball Kinnison | Gray Lensman, protagonist of Galactic Patrol / Gray Lensman / Second Stage Lensmen. |
| Second-stage Lensmen | Lensmen whose minds Arisians expanded; can read/coerce minds tracelessly, with or without a Lens. |
| "Clear ether" / "Clear space" | Lensman greeting/farewell (Wikipedia: traditional greeting; "Clear space" variant: memory). |
| "Sense of perception" | Advanced Lensmen perceive their surroundings by direct awareness, through walls, no eyes needed (Wikipedia). |

## 2. Motif map (tasteful, non-literal)

Principle: one idea per surface, rendered as a quiet detail, never a theme. Fits Rigi because the app is "a photo-based exploration of the compute graph": a Lens is an instrument that lets you perceive a hidden structure, which is exactly what a graph inspector does.

1. Polychrome ring (Lens glow). Inspector/graph node focus ring with a slow conic-gradient shimmer (hue-rotating, low saturation, 1-2 px) only on the active/owned thing. Pairs with the "keyed to its wearer" idea: the ring appears only on the node bound to the current photo/pose. Use brand palette tokens (src/brand/khipu.ts, --rigi-*) rather than raw rainbow so it stays inside the Landeskarte/khipu look; honour prefers-reduced-motion (static gradient). Respect user rule: no decorative coloured shadows, strokes only for state; this ring IS a state.
2. Chromatic fringe, not lens flare. Optional 0.5 px RGB split on the hairline of a selected edge or on the photo-frame corner during graph-run reveal. Pure CSS/WGSL channel offset; avoid classic flare/bokeh blobs (kitsch).
3. "Sense of perception" toggle. Name for the overlay that shows the hidden compute graph over the photo (passes, buffers, readback ring) as if seen through the picture. Label: "Perception" (tooltip "see through the photo"). Flag-style id e.g. `perception`; keeps with src/lib/flags convention.
4. "Clear ether" as ready/idle copy. Status line when graph is idle, device ready, no pending submits ("Clear ether."); "Clear ether" on empty-queue states and as a console banner sign-off. Keep it a few words; sits well beside the Gipfelbuch hand notes.
5. Arisia as the codename for the hidden layer. Dev-facing only: file names, comments, the inspector's "Arisia" panel title, matching upstream luma's own arisia-* roadmaps and branch codex/arisia-ploor-inspector. Nod: the "screen" = the Rigi render canvas; Arisia = the graph behind it. A subtle UI form: a faint "screen" dither/veil that lifts when the inspector opens.
6. Galactic Patrol -> "Patrol" as the CI/regression-gate nickname (scripts/ci/run.mjs). Cheap, internal.
7. Mentor -> the explain/coach voice in Gipfelbuch notes ("Mentor's margin note"), hand-written style. Optional.
8. Boskone / Eddore -> names for failure classes (KNOWN failures in scripts/ci/known-failures.json as "Boskone ledger"). Playful, internal; do not overuse.
9. Second stage -> the opt-in advanced mode (e.g. certified-f32, whole-app-graph islands): "second stage" tier label in the sidebar flags tier list.
10. Lens as wrist object -> a small jewel-shaped hexagon/lens glyph for the inspector toggle, drawn with the existing sketch/notebook line style.
11. Easter egg: a Kinnison/"Gray Lensman" nod is the photo mode named "gray" (desaturated) in terrain styles; zero cost.

## 3. Optics vocabulary that doubles as a pun
lens, aperture (graph entry/exit ports), focal (focal-length solve is already a Rigi concept: concordance focal table), iris (open/close transition for inspector), bokeh (blur of out-of-focus nodes: depth-of-field on unselected graph nodes), diffraction, caustic, refraction (data bending between passes), prism / spectrum / dispersion (polychrome, per-pass colour), shutter (submit), exposure (already used: roll exposure gains), vignette, f-stop, depth of field (focus a subgraph), parallax, loupe (magnifier on the graph), collimate (align), reticle (crosshair for picking), flare (avoid visually). "Focus" and "pass" are free puns.

## 4. Copyright and trademark check (not legal advice)

- US: Project Gutenberg hosts Gray Lensman (ebook 69584), Second Stage Lensmen (70494), Children of the Lens (70483), First Lensman (49525), Triplanetary and Galactic Patrol; each carries the note "extensive research did not uncover any evidence that the U.S. copyright on this publication was renewed". So the 1934-1950s US editions are treated as US public domain through non-renewal. Caveat seen in search: one source claims a 1951 publication would not enter public domain until 2047 under non-renewal-agnostic rules; this conflicts with Gutenberg's research. Original 1930s Astounding serials are the safest layer. The revised book editions (Smith revised Triplanetary and added 1948 prologue material; later Fantasy Press/Pyramid editions) may differ. Outside the US (life+70, Smith d. 1965), works are in copyright in the EU/UK until the end of 2035; Rigi's audience is global (Swiss), so this matters more than US status.
- Trademark: a USPTO search surfaced no active registration for exact "LENSMAN"; only LENSMANHD (reg. 5329838, Class 009 electronic/photographic goods, 2017). Other "lens" marks found were abandoned/cancelled. A 1984 Japanese anime film ("Lensman: Secret of the Lens") exists and the estate/licensees have licensed the name (memory, not verified here), so do not use "Lensman" as a product, feature or brand name; the exact word "Lensman" near a photo/camera product also sits close to LENSMANHD (photographic goods).
- "Arisia" is also a common name (Green Lantern's Arisia Rrab, DC Comics, character trademark/copyright) and upstream luma already uses it as an internal codename; fine for dev docs and file names.

Recommendations (safe):
1. Use short names and allusions only: "Lens", "Arisia", "Clear ether", "Perception", "Second stage", "Mentor". These are common words or short phrases, not protected expression.
2. No quoted passages beyond a few words; no paraphrased plot summaries in the UI; no character art, cover art or the Frank R. Paul / Hubert Rogers illustrations; no Lensman logo.
3. Keep the exact word "Lensman" out of user-visible strings and package names; if mentioned, only in dev docs/credits as "inspired by E. E. Smith's Lensman novels".
4. Add a one-line attribution to NOTICE.md/reports/licences.md ("Names allude to E. E. Smith's Lensman series; no text or art used; not affiliated") and record in the SPDX/licences docs consistent with AGENTS.md.
5. Do not claim affiliation with luma.gl / vis.gl; "Arisia" is theirs as a codename, say "after luma.gl's Arisia program" in dev docs only.
6. Prefer wordless visual nods (polychrome ring) which carry zero legal risk.

## 5. Suggested first steps (cheap)
1. `perception` flag + overlay naming; 2. polychrome ring token in the inspector; 3. "Clear ether." idle status; 4. NOTICE line; 5. CI/Patrol and failure-ledger naming kept to docs.
