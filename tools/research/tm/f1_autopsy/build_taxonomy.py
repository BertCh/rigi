"""F1: hand-coded per-photo failure taxonomy (judgements from sheets/ + records) merged with record facts from master.json.
Cause codes: a_big = stated position wrong > 400 m / wrong vantage; a_small = eye error < 400 m (parallax on a right basin);
b clouds/fog/absent skyline; c near-field / non-DEM foreground; d appearance gap; e narrow FOV; f focal unknown/wrong;
g DEM/drape limitation (near-field ortho blur < ~300 m, smeared steep faces, far drape); h not a clean terrain view
(reflection, crop, grading); i right answer rejected by the rule; j other (GT/verification ambiguity).
stage: search | matching | refine | decision | position | verification.  fix: rule | matcher | matcher+rule | eye-refine |
position-prior | search | none-near-term.  conf: confidence in the primary attribution (high/med/low)."""
import json
from pathlib import Path
H = Path(__file__).parent
M = json.load(open(H/"master.json")); DF = json.load(open(H/"depthfrac.json"))
T = {
"wc_0002": dict(causes=["a_small","c","g"], stage="matching", fix="eye-refine", conf="med",
  evidence="Correct ref C (28.5,-8.3) was proposed (appseeds) but T6 chose sweep40 at 37.1 (483 inl, support 0.13). At the ref, every matcher's fan solve lands 10 deg away (loma/REPORT) -> a pure rotation cannot fit both the near ridge (32% of frame < 300 m in the DEM) and the far skyline: eye/parallax. Near ridge renders as a blurred untextured hump (refpair_a). Eye probe finds similar support at other eyes (155 vs 224)."),
"wc_0006": dict(causes=["i","c","g"], stage="decision", fix="rule", conf="high",
  evidence="T6 pose correct; sky candidate 1935 inl, support 0.707, basin gap 2.3, but matchDominant fails on the 0.3 deg fused-vs-match-only condition and apriori fails on cueAgree 3.8 deg. 49% of frame is DEM terrain < 300 m (ultrawide ridge)."),
"wc_0028": dict(causes=["f","c","d"], stage="refine", fix="matcher+rule", conf="med",
  evidence="Right basin found (T6 1.7 deg from ref, blind verdict near-miss: roll 1.5-2 deg). Focal unknown (iPhone 4, hfov guessed 50), near rock at both edges not in DEM, haze. All matchers solve ~6.5 deg from the ref at the oracle (possible ref/lens issue)."),
"wc_0034": dict(causes=["d","e","c"], stage="matching", fix="matcher+rule", conf="high",
  evidence="T6 pose correct (narrow/app-skyline seed) but ALIKED gets 0 inliers even at the oracle; LoMa 268 inl, correct, still LOW. Backlit dark forest silhouette, 180 mm tele; render at ref matches the ridge shape exactly (refpair_a)."),
"wc_0046": dict(causes=["b","c","d"], stage="decision", fix="matcher+rule", conf="high",
  evidence="T6 pose correct but 96 inl; sea of fog hides the lake/mid-field that dominate the render (refpair_b), trees in front. sweepfine candidate had agree 0.13 deg, skyPx 4.14 (limit 4.0), support 0.80: missed apriori by 0.14 px. LoMa 967 inl correct, LOW."),
"wc_0052": dict(causes=["d","c"], stage="matching", fix="matcher", conf="high",
  evidence="Sun in frame, backlit haze. ALIKED 0 inliers at the oracle; LoMa 225 inl -> HIGH correct in the LoMa T6 arm. Sky candidate 3.2 deg from the ref existed with 0 inliers (search OK)."),
"wc_0055": dict(causes=["c","d","g"], stage="matching", fix="none-near-term", conf="high",
  evidence="T6 pose correct via app skyline, 1 inlier; every matcher <= 20 inl at the oracle. Parking lot/van/roof ~40% of frame, fresh snow on a forested cliff; the cliff renders as smeared vertical drape (refpair_b)."),
"wc_0063": dict(causes=["i","c"], stage="decision", fix="rule", conf="high",
  evidence="T6 pose correct, apriori AND matchDominant true (1188 inl, support 0.91, agree 0.07 deg) - rejected only by basin gap 0.182 < 0.20 on a hand-placed position. LoMa arm: HIGH correct."),
"wc_0071": dict(causes=["d","c"], stage="decision", fix="matcher+rule", conf="med",
  evidence="T6 pose correct, 422 inl but support 0.37, skyPx 9.2. Snow-covered mountain vs summer drape, ice/lake foreground (45% of DEM frame < 300 m). LoMa 753 inl, support 0.24, still LOW."),
"wc_0072": dict(causes=["d","c"], stage="decision", fix="matcher+rule", conf="med",
  evidence="T6 pose correct, 130 inl, support 0.50, basin gap 0.057 (hand-placed). Haze, leaf-off branches over the frame, snowy distant crest vs snowless render. LoMa 637 inl correct, LOW."),
"wc_0076": dict(causes=["j"], stage="verification", fix="none-near-term", conf="high",
  evidence="T6 HIGH (matchDominant, 1915 inl, gap 0.80); pose within 1 deg of the correct ref B but its own cluster verdict is 'unsure'. A GT/verification ambiguity, not a pipeline failure."),
"wc_0001": dict(causes=["a_small","d","c"], stage="matching", fix="eye-refine", conf="low",
  evidence="EXIF GPS. T6 LOW-wrong at 101.8 (911 inl, support 0.60; verdict pitch-offset+roll) - roughly the right direction (manifest heading 89). Ring: stated eye on a slope with terrain blocking 0-95 deg; the range in the photo is taller than any range in the ring near 100 deg. Eye probe: 563 inl at another eye vs 207 (2.7x). Winter snow vs summer drape, larch + snow-slope foreground."),
"wc_0005": dict(causes=["c","d","g"], stage="matching", fix="matcher+rule", conf="med",
  evidence="EXIF GPS. All methods land at yaw ~191 (verdict near-miss, pitch-offset); LoMa 404 inl there. Ring confirms Alps visible only through 180-200 deg, 40-90 km away. Trees frame ~60% of the photo, dusk light, skyline beyond the 40 km drape radius for non-narrow photos. Stated eye sits below the Uetliberg crest (near hill blocks 20-150 deg); possibly the tower/viewpoint height."),
"wc_0010": dict(causes=["a_small","h","d"], stage="position", fix="eye-refine", conf="med",
  evidence="EXIF (Unsplash import). Right basin: fused 236.5 verdict parallax-mismatch/near-miss (Saentis labelled). Photo is at water level (reflection axis = horizon), ring shows the stated eye ~20 m above Seealpsee on the slope (lake well below horizon). Half the frame is a mirror reflection; strong colour grading; winter snow."),
"wc_0013": dict(causes=["e","g","d"], stage="matching", fix="none-near-term", conf="med",
  evidence="EXIF. Right basin: fused 266.1 near-miss/parallax with Huetstock (3.8 km) on the skyline (ov_parallax). 16 deg portrait tele of a sheer limestone face; in the ring that face renders as vertically smeared ortho texture. 0 inliers at every eye."),
"wc_0015": dict(causes=["b","c","d"], stage="search", fix="none-near-term", conf="med",
  evidence="Hand-placed. Ring at ~215-240 deg shows a slope rising to the right with lower Jura ridges left, consistent with the photo, but no candidate was proposed there (T6 candidates 59/343/356/304/187). Fog sea gives a fake flat horizon, ~70% of frame is near snow slope, winter snow vs summer drape; 0 inliers everywhere."),
"wc_0023": dict(causes=["e","b","d"], stage="search", fix="matcher", conf="low",
  evidence="Hand-placed, 200 mm (hfov 10). Ring shows a snowy peak at ~190 deg just above a green slope rising to the right - the photo's layout; T6 chose 202 (wrong-direction). A sky candidate at 196.7 had 77 inl/support 0.32 (unverified). Clouds around the massif base. LoMa arm has no record for this photo."),
"wc_0033": dict(causes=["d","c"], stage="matching", fix="matcher", conf="med",
  evidence="EXIF (train). ALIKED 0 inliers everywhere; LoMa found 1219 inl at yaw 61, pitch -5.8 (LOW, unverified). Ring at 30-95 deg shows forested slope -> lake -> Buergenstock-like peninsula, matching the photo layout; T6's 25 deg is wrong. Haze, trees ~50% of frame. Needs blind verification of the LoMa pose."),
"wc_0035": dict(causes=["a_big","d"], stage="position", fix="position-prior", conf="med",
  evidence="Hand-placed. Ring: from the stated eye a hillside rises to +15 deg over 0-80 deg, i.e. exactly where the photo (heading 75, Wisenberg) shows an open elevated view. Title 'von der Belchenflue'; the stated point appears to be off the summit (my estimate ~1 km W; not measured). 0 support at all eyes <= 400 m. Haze, winter-brown meadows."),
"wc_0037": dict(causes=["a_small","d","c"], stage="matching", fix="eye-refine", conf="low",
  evidence="Hand-placed at a valley road. App, fused and cascade all land at 244-248 deg with parallax-mismatch/yaw-shift verdicts (ov_parallax): right massif, eye likely off. Evening light (19:31), fresh spring snow above larch forest vs summer drape; 0 inliers at all eyes <= 400 m."),
"wc_0040": dict(causes=["c","d","e"], stage="search", fix="search", conf="high",
  evidence="EXIF, position fine (Gruyeres old town). Ring shows Moleson at ~225-235 deg; no T6 candidate within 90 deg of it (124/64/77/337/29). Buildings form the skyline on both sides (~65% of frame), snowy Moleson; hfov 25 routes to the narrow path whose app-skyline seeds were wrong."),
"wc_0053": dict(causes=["d","h"], stage="matching", fix="none-near-term", conf="med",
  evidence="EXIF. Right basin: app/fused at 297-299 deg near-miss (Piz Padella 3.2 km, ov_parallax). Fully snow-covered massif at 07:30 vs summer drape; panoramic crop (2.36:1). 0 inliers for every matcher at every eye."),
"wc_0058": dict(causes=["b","g","a_small"], stage="matching", fix="none-near-term", conf="low",
  evidence="Unsplash import, position = Netstal town. Cloud hides skyline and base; the visible face is layered limestone that renders as smeared drape in the ring. Fog below the camera suggests an elevated vantage vs the valley-floor eye (uncertain). Fused pose verdict unsure."),
"wc_0069": dict(causes=["a_big","d"], stage="position", fix="position-prior", conf="high",
  evidence="Hand-placed at Stoos (eye 1335 m); title 'from Fronalpstock' (summit ~1920 m). Ring: 180-290 deg (the whole lake view) is blocked by the Fronalpstock slope; the photo looks down on the lake. Wrong-ref overlay shows the DEM skyline far above the photo's. T6/LoMa lock onto a strong wrong basin at 281 (the known gross-error trap)."),
"wc_0070": dict(causes=["a_small","c"], stage="position", fix="eye-refine", conf="med",
  evidence="EXIF. Ring at 300-330 deg shows the same grassy peak + rocky Gandstock pair, smaller/shifted: right basin, parallax. Fused 320.4 near-miss/parallax-mismatch; peaks at 0.6 km so a tens-of-metres eye error matters; photographer at the tarn shore. Eye-probe candidates (high/open points) all got 0."),
"wc_0073": dict(causes=["a_big","d"], stage="position", fix="position-prior", conf="high",
  evidence="EXIF GPS is ~16 km off: stated eye at 490 m near a lake shore; title 'Matthorn from pilatus', photo taken from the Pilatus summit (~2100 m). Nothing in the ring resembles the photo."),
"wc_0074": dict(causes=["a_small"], stage="position", fix="eye-refine", conf="high",
  evidence="Hand-placed. v2 moved the eye 225 m and both blind verifiers called the moved-eye pose correct; the same rotation at the stated eye is a known-wrong ref. T6 at the stated eye: 1798 inl, support 0.54 on a wrong pose. Not in refs.correct_refs (moved-eye verdicts are not inherited)."),
"wc_0086": dict(causes=["a_small","c"], stage="position", fix="eye-refine", conf="high",
  evidence="Panoramio. Stated eye is below the San Salvatore summit dome: ring blocked 0-150 deg. Moving 25 m to the high point gives 1611 inl and a HIGH that verifiers split correct / near-miss (right ridge 1.75% high). Viewing platform + people in foreground."),
"wc_0087": dict(causes=["a_big","b","d"], stage="position", fix="position-prior", conf="med",
  evidence="Hand-placed. Dents du Midi spans ~20 deg and rises ~8 deg above the fog in the photo; from the stated eye the only candidate serrated range (~190-200 deg) is ~1-2 deg tall -> camera several times closer than stated (order 10 km vs 27 km, estimate). Sea of fog, winter."),
"wc_0095": dict(causes=["a_big","c"], stage="position", fix="position-prior", conf="high",
  evidence="Hand-placed with 2-decimal coords (46.43, 7.789 -> +-500 m). Ring from the stated eye: a steep slope and a nearby big range (Bietschhorn-like pyramid ~5-8 km) fill the view; the photo is a distant 4000 m panorama seen across a deep valley from a gentle grassy knoll. Title 'Ausblick geniessen' names no place; person + signpost foreground."),
"wc_0098": dict(causes=["d","g","c"], stage="matching", fix="none-near-term", conf="low",
  evidence="Panoramio, valley floor (Safiental area). Heavy winter snow, spruce framing, looking steeply up at a horn; ring shows enclosed steep faces that render as smeared drape (and are clipped by the ring's vfov). LoMa 38 inl at pitch 24 (unverified). Position unverifiable from the ring."),
}
out = {}
for pid, t in T.items():
    r = M[pid]
    out[pid] = dict(t, t6=dict(level=r["t6"]["level"], verdict=r["t6"]["verdict"], inliers=r["t6"]["checks"].get("inliers"),
                               support=r["t6"]["checks"].get("matchSupport"), unmet=r["t6"]["checks"].get("unmet")),
                    hasCorrectRef=bool(r["correctRefs"]), positionSource=r["posSrc"], positionNote=None,
                    eyeProbeBest=r["eyeProbeBest"], loma=r["loma"] and {k: r["loma"][k] for k in ("level","inl","verdict")},
                    demDepthAtRef=DF.get(pid), tags=r["tags"], title=r["title"],
                    sheets=[s for s in (f"sheets/{pid}_ring.jpg",) if (H/s).exists()])
assert len(out) == 31
json.dump(dict(about=__doc__, photos=out), open(H/"taxonomy.json", "w"), indent=1)
from collections import Counter
print(Counter(c for t in T.values() for c in t["causes"]))
print("primary(first) ", Counter(t["causes"][0] for t in T.values()))
print("stage", Counter(t["stage"] for t in T.values()))
print("fix", Counter(t["fix"] for t in T.values()))
print("fix x conf", Counter((t["fix"], t["conf"]) for t in T.values()))
