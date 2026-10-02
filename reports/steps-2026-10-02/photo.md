# Step ① photo: review, research, plan (2026-10-02)

Step lead: Opus pod for Gipfelbuch node `photo` (`src/lib/gipfelbuch/graph.ts`). Owned modules: `src/lib/photos.ts`, `src/lib/upload/exif.ts`, plus the unowned rest of `src/lib/upload/**` and `scripts/ingest.mjs`. `src/lib/geo/photo-meta.ts` belongs to `baseline-pipeline`, so changes there are proposals only.

Team note: the shared 20-agent cap was full for the whole session, so every Sonnet spawn was refused (five tries). The lead did the review, the fuzz probe, the research and the implementation alone. No independent Sonnet adversarial review ran; the lead reviewed its own diff against a checklist (below).

## 1. Current state

| Piece | Where | What it does |
|---|---|---|
| EXIF read | `src/lib/upload/exif.ts:88` `readExif` | Two exifr 7.1.3 parses: translated values plus makerNote, and raw time strings |
| Apple gravity | `exif.ts:121` `parseAppleMakerNote`, `appleGravity` | Hand-parsed MakerNote tag 0x0008 with a byte-order check, bounds checks and a guard for zero denominators |
| Pitch, roll, holding | `exif.ts` `orientationFromGravity` | Picks one of four holdings, restricted to the displayed aspect |
| Focal | `exif.ts` `vfovFromF35` and `src/lib/camera/focal.ts:61` `focalPxFromF35` | Diagonal 35 mm-equivalent conversion. It is crop-aware (ExifImageWidth/Height vs the decoded source size) |
| Time | `exif.ts` `captureTime`, `offsetFromLongitude` | GPS UTC first, then DateTimeOriginal with OffsetTime*. With no zone, round(lon/15) |
| Meta | `exif.ts` `buildPhotoMeta` | Builds `PhotoMeta` plus `local` unknowns (`yawUnknown`, `pitchRollUnknown`, `focalUnknown`, `positionSource`, `timeSource`, `headingRef`) |
| Decode | `src/lib/upload/decode.ts` | Native decode (`createImageBitmap` from-image, then `<img>`), then libheif in a worker for HEIC (LGPL, separate asset), then main thread. 2048 px cap. Upright small JPEGs pass through byte-for-byte |
| Ingest | `src/lib/upload/index.ts` | `prepareUpload` (hash, EXIF, decode, meta), `withPosition` (pin), Overpass region, IndexedDB |
| Bundled ingest | `scripts/ingest.mjs` | Builds `public/photos/photos.json` from `img/*.HEIC` with sips. It has **its own copy** of the MakerNote, gravity and time code |
| Third reader | `src/lib/geo/photo-meta.ts:49` `parseAppleGravity`, `readPhotoMeta` | Used by baseline-ui and the concord focal table |
| Consumers of the unknowns | `integration/unknown-pose.ts:42-51`, `geocam/priors/photo-priors.ts:100-106`, `roll/align/viewpoint.ts:44` | They free yaw, pitch/roll and focal when the flags are set |
| Magnetic heading | `geocam/priors/heading.ts` | WMM declination only behind `?geoDecl` (off). By default an `M` heading is used as if it were true north |

Specs: `upload/__tests__/{exif,decode,index,region,region-fetch,licenses}.spec.*` and `lib/__tests__/photos.spec.tsx`. Pod A has `decode-pipeline` and `store` specs in flight. Coverage of `exif.ts` is good. Its gaps were the implausible-value cases below. This step has no GPU island; EXIF is CPU, and photoprep belongs to `skyline`.

## 2. Findings (ranked)

Probe: `scratchpad/fuzz/probe.mts` (synthetic tags) and `scratchpad/fuzz/parity.mts` (rebuilds the 19 `img/*.HEIC` metas and compares them with `photos.json`).

| # | P | Finding | Evidence | Status |
|---|---|---|---|---|
| F1 | P1 | GPS at exactly (0, 0) ("null island", a receiver with no fix) or out of range was accepted as a real `exif` position. The upload then fetched an Overpass region at 0,0, and roll import clustered the photo there instead of interpolating it | `buildPhotoMeta` `hasGps = finite(lat) && finite(lon)` | **fixed** in `exifPosition`, plus `diagnostics.gpsRejected` |
| F2 | P1 | A zeroed or garbled AccelerationVector, e.g. [0,0,0] from all-zero denominators, became a **trusted** pose of pitch 0, roll 180°, landscape-left with `pitchRollUnknown: false` | probe: `orientationFromGravity([0,0,0])` → roll 180 | **fixed**: \|g\| must be in 0.5–2 g and finite, otherwise unknown |
| F3 | P1 | A GPSDateStamp of "0000:00:00" became takenAt 1899-11-30 with source `gps`. That is a wrong sun position and a wrong roll sort | probe | **fixed**: a year before 1980 or a bad month/day falls through to DateTimeOriginal |
| F4 | P2 | FocalLengthIn35mmFormat of 1 or 65535 was trusted (vfov 1.5°) and `focalUnknown` was false. `exifDiagnostics.hasF35` accepted 0, which disagreed with `buildPhotoMeta` | probe | **fixed**: `exifF35`, range 5–3000 mm, shared by both |
| F5 | P2 | A heading of 360, -5 or 720 was stored unnormalised. `priorHeading` wraps only on its declination path | probe | **fixed**: `exifHeading` wraps to [0, 360); in-range values are returned unchanged, bit for bit |
| F6 | P2 | A square image (square crop) always got a landscape holding, so a portrait-held square photo had its roll 90° off | `orientationFromGravity` aspect filter | **fixed**: a square image picks among all four by gravity |
| F7 | P3 | exifr `silentErrors` returns `{errors:[…]}` for a broken file, and `exifDiagnostics.hasExif` read that as true | probe | **fixed** (`withoutErrors`) |
| F8 | P3 | `formatTakenAt` showed UTC for EXIF's colon-less offsets (`+0530`) | `photos.ts:153` | **fixed** |
| F9 | P3 | `buildPhotoMeta` threw a RangeError for a non-finite `fallbackTime` | probe | **fixed** |
| F10 | P1 (proposal) | `geo/photo-meta.ts:49` `parseAppleGravity` has no bounds check on the value offset (a RangeError, so `readPhotoMeta` rejects), divides by a zero denominator (Infinity/NaN gravity), and ignores the byte order (`II` → garbage). baseline-ui and the concord focal table read this | code read | for the **baseline-pipeline** owner: replace it with `parseAppleMakerNote(makerNote)[0x0008]` from `upload/exif.ts` plus the same norm guard |
| F11 | P2 | `scripts/ingest.mjs` duplicates the MakerNote, gravity and time code (lines 59-161) without bounds checks. Its `captureTime` calls `toISOString()` on an Invalid Date (a throw), and it uses `f35 ?? 26`, which keeps 0. It also ignores GPSAltitudeRef. Drift risk with every fix | code read | **next** (U3) |
| F12 | P2 | Holding comes from the displayed aspect. A crop that flips the aspect (a landscape-held shot cropped tall) picks a holding 90° off | code read | **later** (U5, flag) |
| F13 | P2 | By default a magnetic (`M`) heading is used as true north. Alpine declination is about 3°, roughly the size of the 1° accept band ×3. A fix exists behind `?geoDecl` (off) | `heading.ts` | **needs a gate** (owned by `camera-prior`; noted only) |
| F14 | P2 | No XMP is read. DJI gimbal pose (`drone-dji:GimbalYaw/Pitch/RollDegree`) and GPano `Pose*Degrees` are ignored, so drone uploads run as yaw, pitch/roll and focal unknown | `readExif` options | **later** (U4, flag) |
| F15 | P3 | `readExif` parses each file twice. That is harmless at upload rates | code read | won't fix |
| F16 | P3 | README drift: `src/lib/upload/README.md` cites `out/lead/upload/*.test.ts` and `verify.mjs`, which are gitignored and local-only. The Vitest specs are the real gate now | README | doc-only, later |

Privacy check: the JPEG passthrough keeps the full EXIF, but it stays in IndexedDB. `src/lib/share/index.ts:7` shares bundled demo photos only, so no upload leaves the device.

## 3. Research summary

- **exifr 7.1.3** (installed) parses XMP when `xmp: true`, with output grouped by namespace (`output.GPano`, `output['drone-dji']`), in its full and lite builds (`node_modules/exifr/README.md` lines 42, 139, 516-522). So U4 needs no new dependency.
- **DJI** writes `GimbalPitchDegree` with -90 meaning nadir. There is no authoritative statement on whether `GimbalYawDegree` is true or magnetic north: [PTGui thread](https://groups.google.com/g/ptgui/c/Msq1lMH7z34), [DJI SDK forum](https://sdk-forum.dji.net/hc/en-us/community/posts/18414276028185/comments/18577358991129), [Pix4D community](https://community.pix4d.com/t/mixed-up-roll-pitch-and-yaw/15807). So an XMP yaw must enter as a *hint* with a wide prior. It cannot be a compass-grade seed until it is measured.
- **Phone compass error** is typically 5–10°, and 30–40° under interference ([OU study on AR navigation compass errors](https://oro.open.ac.uk/84729), [Mapillary heading reports](https://forum.mapillary.com/t/image-heading-data-broken/3459)). This agrees with the Gipfelbuch claim "the compass drifts" and with the bench treatment of heading as a hint (`reports/bench-ablation.md` `--weak-heading`).
- **Gravity**: `reports/geometry-first-pose.md:51` models gravity at 1–2°. The norm guard in F2 does not touch that, because it rejects only physically impossible readings. All 19 bundled vectors have \|g\| between 0.978 and 1.078.
- **Recorded negatives** that this step must not redo: monocular-depth FOV as a prior or veto (X2, `negative-results.md:50`; EXIF focal 0.55° beats MoGe and DA3) and the looser accept rule using EXIF (`negative-results.md:20`). Nothing in this step changes the accept path.
- **Time zones**: a real lat/lon → IANA lookup needs a dependency (for example `tz-lookup` or `geo-tz`). That is the user's decision (D2). The round(lon/15) guess is already flagged `tzEstimated` and excluded from roll interpolation (`roll/import/index.ts:119`).

## 4. Plan

| Unit | What | Size | Risk | Gate | When |
|---|---|---|---|---|---|
| U1 | Plausibility guards F1–F9 + specs | S | Low. Bit-identical for in-range EXIF: parity on the 19 HEICs is unchanged before and after (the one remaining diff, IMG_4703 vfov, is the probe not passing the crop source size, and it is the same on master) | vitest exif + photos specs, tsc, fast tier | **landed** |
| U2 | This plan doc | S | none | — | **landed** |
| U3 | `scripts/ingest.mjs` imports `parseAppleMakerNote`, `orientationFromGravity` and `captureTime` from `src/lib/upload/exif.ts` (it already runs under tsx). It removes about 100 duplicated lines. For the 19 HEICs, prove photos.json is unchanged with a dry-run diff | S | Low. ingest needs sips and network to run fully, so the proof is a dry-run of the meta builder only | parity script, identical photos.json fields | next |
| U4 | `readExif` also reads XMP (`xmp: true`) into `local.xmp`, as data only: DJI gimbal yaw/pitch/roll, FlightYaw, RelativeAltitude, GPano Pose*. Behind a new flag `xmpPose` (declared in `src/lib/flags`). With the flag on, pitch/roll come from the gimbal (DJI pitch maps straight to our pitch-up+ convention) and yaw becomes a *hint* (yawUnknown stays true). Specs use synthetic XMP packets | M | Medium: a new prior path, so it stays opt-in until a drone dev set exists | flag off = bit-identical; spec | later |
| U5 | Holding from EXIF Orientation × gravity: when the best off-aspect candidate beats the best on-aspect one by a wide margin (crop flipped the aspect), set `local.holdingAmbiguous` and free roll. Flag-gated | S | Medium (roll prior) | dev-split A/B, opt-in | later |
| U6 | Derive f35 from FocalLength + FocalPlaneX/YResolution when FocalLengthIn35mmFormat is missing (DSLRs, some Androids). Keep `focalUnknown: true` but seed f35 better | S | Medium: FocalPlaneResolution often refers to a different frame | flag + spec | later |
| U7 | Proposal for baseline-pipeline: F10 (`geo/photo-meta.ts` reuses `parseAppleMakerNote` and the norm guard) | S | Low | its owner's specs | owner |
| U8 | README refresh for `src/lib/upload/README.md` (verification section → Vitest specs; out/lead paths marked historical) | S | none | — | later |

## 5. Gipfelbuch corrections (do not edit graph.ts; for the Gipfelbuch owner)

- `graph.ts` node `photo`, `modules`: add `src/lib/upload/decode.ts`, `src/lib/upload/index.ts`, `src/lib/camera/focal.ts` and `scripts/ingest.mjs`. The upload, decode and ingest path is the step, and it is not listed under any node.
- `lede` "The phone also records … how it was tilted": only iPhones do (Apple MakerNote). Suggested: "An iPhone also records where it was, which way it faced, how it was tilted, and the lens; other cameras record less, and the solver frees what is missing."
- `summary` "It optionally has a position, one camera prior and a region": a photo has no "camera prior" field. Suggested: "A photo is an image with its size and time, and whatever the phone recorded: position, heading, gravity tilt and lens. What is missing or implausible is marked unknown, and the solver frees it."
- `src/lib/gipfelbuch/pages/photo.tsx:699` "Tags are read as written": since U1, implausible tags read as missing. Suggested: "Tags are read as written, except values no real camera writes (GPS at 0, 0; a zero gravity vector; a 1 mm or 65535 mm focal), which read as missing."

## 6. Decisions for the user

- D1: should magnetic headings be declination-corrected by default (`?geoDecl`)? This is the `camera-prior` step's gate. It is listed here because `photo` is where the `M` ref is read.
- D2: add an offline lat/lon → time-zone dependency (for example `tz-lookup`, small, CC0/MIT) to replace round(lon/15)? A new dependency in package.json needs your approval.

## 7. Landed

- U1: `upload: EXIF plausibility guards …` (sha in section 8 after landing).

## 8. Log

(Filled in after landing.)
