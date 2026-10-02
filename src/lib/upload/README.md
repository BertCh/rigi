# Upload track: API note

> Moved from an API note in `out/lead/` on 2026-09-29. Any `out/lead/...` test, sample or result path below is local-only (gitignored).

Browser photo upload for Rigi. `/upload` takes a JPEG, HEIC, PNG, WebP or AVIF (RAW/TIFF are rejected with an export hint), builds the same `PhotoMeta` that `scripts/ingest.mjs` builds, gets OSM peaks, trails and lakes, stores everything in IndexedDB, and opens the photo in the existing `PhotoWorkspace` at `/photo/local-<hash>`.

## Files (owned by the upload track)

| File | Purpose |
|---|---|
| `src/lib/upload/exif.ts` | Pure EXIF → `PhotoMeta` code with no DOM, so it also runs in node. It is a faithful port of ingest.mjs: `parseAppleMakerNote`, `orientationFromGravity`, `vfovFromF35`, `captureTime`, `outputSize`, `buildPhotoMeta`, `readExif` and `exifDiagnostics` |
| `src/lib/upload/decode.ts` | Decodes the image upright and caps it at 2048 px. Uses native decode (`createImageBitmap` with `from-image`, then `<img>`). HEIC falls back to libheif in a worker, then to libheif on the main thread. Also has JPEG passthrough, the thumbnail, `contentHash` and `isHeif` sniffing |
| `src/lib/upload/heic.worker.ts` | libheif decode worker. It loads libheif from `LIBHEIF_URL` at runtime; libheif is not bundled into it |
| `src/lib/upload/licenses.ts` | LGPL notice data (`THIRD_PARTY`, `LGPL_TEXT` taken raw from the package, `LIBHEIF_FILE_URL`), shown in the `/upload` "Credits and licences" footer |
| `src/lib/upload/region.ts` | Overpass queries (same as ingest.mjs), timeouts, mirrors, the bundled-region reuse and the cache |
| `src/lib/upload/store.ts` | IndexedDB `rigi-uploads` with stores `photos` {id, meta, blob, thumb} and `regions` (RegionData) |
| `src/lib/upload/index.ts` | Public API (below) |
| `src/lib/upload/SlippyMap.tsx` | Dependency-free OSM raster map: click to pin, drag to pan, wheel or double-click to zoom. Draws an accuracy circle and a heading wedge |
| `src/lib/upload/libheif.d.ts` | Typings for `libheif-js/libheif-wasm/libheif-bundle.mjs` |
| `src/routes/upload.tsx` | `/upload` route (ssr: false) |
| `out/lead/upload/exif.test.ts` | Node test against photos.json |
| `out/lead/upload/region.test.ts` | Node test of fetchRegion sharing, abort and bundled-reuse semantics (fetch mocked) |
| `out/lead/upload/verify.mjs` | Playwright end-to-end test |

## Exports (`#/lib/upload`)

```ts
prepareUpload(file: File, onStage?): Promise<UploadDraft>   // hash, EXIF, decode; meta.lat/lon are NaN if there is no GPS
withPosition(draft, lat, lon): LocalPhotoMeta                // rebuild the meta from a map pin (alt/hAccuracy become null)
regionFor(meta, {signal, onProgress, force}): Promise<LocalRegion>
saveUpload(draft, meta, region | null): Promise<{meta, region}>    // region null → stored with an empty region
restoreLocalPhoto(id): Promise<{meta, region, blobUrl} | null>     // meta.src === blobUrl
listLocalPhotos(): Promise<{id, meta, thumbUrl}[]>                 // newest first
deleteLocalPhoto(id)                                               // also garbage-collects unreferenced local regions (gcRegions)
refreshLocalRegion(id)
ensureLocalPhotoRegistered(id): Promise<LocalPhotoMeta | null>     // restore + registerWithWorkspace
registerWithWorkspace(meta, region | null): boolean                // photos.registerLocalPhoto; seeds regionCache only for local-* regions
registerHook(): ((meta, region | null) => void) | null             // feature-detects photos.registerLocalPhoto
isLocalPhotoId(id), isLocalRegionId(id), hasPosition(meta), HeicUnsupportedError, isHeif
buildPhotoMeta, readExif, parseAppleMakerNote, orientationFromGravity, vfovFromF35, captureTime, fetchRegion, regionIdFor
```

`LocalPhotoMeta = PhotoMeta & { local: { yawUnknown, positionSource: 'exif'|'pin', timeSource: 'gps'|'exif'|'exif-local'|'file', tzEstimated?, headingRef, fileName, fileType, fileBytes, addedAt } }`. It is assignable to `PhotoMeta`. `id` is `local-` followed by the first 10 hex characters of the file's SHA-256. On plain-http LAN origins, where `crypto.subtle` is missing, it is `local-f…` from a sampled FNV-1a hash instead.

### Usage

```ts
import { prepareUpload, regionFor, saveUpload, registerWithWorkspace } from '#/lib/upload'
const draft = await prepareUpload(file)
const meta = draft.meta                                   // or withPosition(draft, lat, lon) when there is no GPS
const region = await regionFor(meta).catch(() => null)
const saved = await saveUpload(draft, meta, region)
registerWithWorkspace(saved.meta, saved.region); navigate({ to: '/photo/$id', params: { id: meta.id } })
```

## Integration status

The workspace hook has landed:
- `photos.ts` exports `registerLocalPhoto(meta, region)`. `getPhoto` checks `localPhotos` first, and `regionCache` is seeded.
- `photo.$id.tsx` loader: for an unknown `local-*` id it lazy-loads `src/lib/upload/index.ts` via `import.meta.glob` and calls `ensureLocalPhotoRegistered(id)`. Cold reloads of `/photo/local-…` therefore restore from IndexedDB, and verify.mjs checks this.

*Update (2026-10-01): both items below are done. `src/lib/integration/unknown-pose.ts` runs a 360° yaw search (CPU cascade, then the fused `/match` sweep) when the heading is unknown, and the Heading slider in `PhotoWorkspace.tsx` spans 0–360° when `unknowns.yaw`. The original request is kept for the record.*

Originally wanted for uploads with no heading (`(photo as LocalPhotoMeta).local?.yawUnknown`, equivalently `photo.heading == null`):
1. **Solver** (`align.ts` / `deck/engine.ts`): run the coarse yaw grid over the full 360° instead of ±25° around `heading ?? 0`. When this was written, the since-removed three.js `engine.ts` used `yaw: photo.heading ?? 0` (check `align.ts` and `deck/engine.ts` for the current seed) with the ±25° window, so these uploads usually misalign.
2. **Manual Heading slider** (`PhotoWorkspace.tsx:599`): its range is `(photo.heading ?? 0) - 40` to `(photo.heading ?? 0) + 40`, so with no heading the user cannot set anything outside about ±40° of north and cannot fix the alignment by hand either. When `heading == null`, use the full 0–360° range (wrap-around).

Also: pinned photos have `alt: null`, so the engine uses DEM + 1.8 m. That is the right behaviour. `photos.ts registerLocalPhoto` already accepts `region: null`; `registerWithWorkspace` passes null for bundled region ids so `loadRegion('region-1')` still fetches the live JSON.

## Behaviour details

- **EXIF**: exifr (full build) reads HEIC and JPEG in the browser. The code uses the same two parses as ingest.mjs: translated values plus makerNote, and raw strings for the time (GPS UTC first, else DateTimeOriginal + OffsetTimeOriginal, else File.lastModified with `timeSource: 'file'`). The Apple MakerNote tag 0x0008 gives gravity, which gives pitch, roll and holding via the same candidate search as ingest. vfov comes from `f35 * diag / 43.2666` on the displayed, resized size. f35 defaults to 26 when missing. GPSAltitudeRef = 1 (below sea level) is honoured. ingest ignores it, which makes no difference in the Alps.
- **Implausible values** (2026-10-02): GPS at exactly (0, 0) or out of range reads as no GPS (`diagnostics.gpsRejected`, pin needed); a gravity vector with |g| outside 0.5–2 g or non-finite reads as no gravity (`pitchRollUnknown`); FocalLengthIn35mmFormat outside 5–3000 mm reads as unknown (`focalUnknown`, default 26); a GPSDateStamp before 1980 falls through to DateTimeOriginal; headings are wrapped to [0, 360); a square image lets gravity pick the holding among all four. In-range values are unchanged (the 19 bundled HEICs give identical metas).
- **Decode**: HEIC is detected by `ftyp` brand, not by file name. libheif applies `irot`, so the output is upright; HEIC EXIF Orientation is never applied a second time. An upright JPEG that is already ≤ 2048 px is stored byte-for-byte (`decoder: 'passthrough'`). Anything else is re-encoded as JPEG q0.86. Thumbnails are 360 px.
- **Time zone**: a DateTimeOriginal without OffsetTime* and without GPS time (typical for non-Apple cameras) gets `timeSource: 'exif-local'`. Once a position is known, the zone is guessed as `round(lon / 15)` h (`tzEstimated: true`, `tzOffset` set) and takenAt is shifted. This ignores political zones and DST, so it can be about 1 h off in Alpine summer; the UI warns about it. Before a position is known, the time is read as UTC, as ingest.mjs does.
- **No GPS** (iOS Safari photo picker since 16.4): the page explains Options → Location in the picker, or Files / AirDrop, and moves the map above the preview. The user clicks the map or types "lat, lon". Other flags shown: missing heading (360° search), magnetic heading, no gravity (pitch/roll 0), unknown lens, and GPS accuracy worse than 50 m.
- **Region**: the order is memory → a bundled `public/photos/region-*.json` when the photo's exact position is within 6 km of that region's centre → IndexedDB → Overpass. A bundled region is only referenced (`meta.region = 'region-1'`), never copied into IndexedDB, and never seeded into photos.ts `regionCache`, so it stays current when ingest regenerates it. The memo is keyed `bundled:<id>` for bundled hits and by the 0.05° cell otherwise, so a second photo in the same cell but beyond 6 km does not inherit the bundled region. Concurrent callers share one fetch, which runs on its own AbortController. Aborting a caller's `signal` only detaches that caller. The shared fetch is aborted only when no caller has been left for `ABANDON_GRACE_MS` (1.5 s), so a re-pin inside the same cell (effect cleanup aborts, then re-requests) rejoins the fetch already in flight. Overpass is tried at overpass-api.de (retried once after a fast 429/504), then private.coffee, then kumi.systems, with 45 s timeouts per request. Peaks and trails are fetched in parallel, then water. If trails fail, the region is marked `partial` and refetched next time. An older cached region is used if the network fails. The UI has Skip and Retry buttons. Region ids are `local-region-<lat>_<lon>` on a 0.05° grid. The trail bbox is widened by 3 km to cover the snap offset.

## HEIC dependency and licence

**`libheif-js@1.23.2`** was added to package.json dependencies with `npm install`. **That is outside the upload track's owned files, and the lead needs to sign off on it.** The package is **LGPL-3.0**: an Emscripten build of strukturag/libheif (LGPL-3.0) with the libde265 HEVC decoder (LGPL-3.0) embedded.

How the LGPL is met:
- **Separate, replaceable file.** `decode.ts` imports `libheif-js/libheif-wasm/libheif-bundle.mjs?url`, so Vite emits the unmodified 1,989,119-byte bundle as a single asset (`assets/libheif-bundle-<hash>.mjs`). It is not minified or inlined. The worker loads it with a runtime `import()` of that URL, and so does the main-thread fallback, so there is one copy. An isolated `vite build` gives `heic.worker-<hash>.js` at 641 bytes plus that one libheif file. Served from `vite preview`, headless Chromium decoded the portrait `IMG_7068.HEIC` to 1536×2048 through the worker.
- **Notice.** `/upload` has a "Credits and licences" footer: OSM/ODbL attribution, libheif and libde265 with versions, licence and source links, a link to the libheif file, and the full LGPL v3 + GPL v3 text (`libheif-wasm/LICENSE`, imported `?raw`).

The worker builds its importer with `new Function('u', 'return import(u)')`. A visible non-literal `import()` makes Vite dev inject `/@vite/client` into the worker, and that client's CSS-HMR handler throws "document is not defined" inside the worker. A future Content-Security-Policy would therefore need `'unsafe-eval'`. The alternative is to serve libheif from `public/` as a classic script.

If a browser's classic workers can't run dynamic `import()`, the decode falls back to the main thread, which works but blocks the UI for about 1 s. If LGPL is unacceptable, remove the dependency: `decodeImage` then throws `HeicUnsupportedError`, and the route shows the "export as JPEG / use Safari" message. The bundle is about 2 MB and loads only when a HEIC fails native decode (Chrome and Firefox; Safari decodes natively).

## Verification (run on :3100)

- `npx tsx out/lead/upload/exif.test.ts`: all 13 `img/*.HEIC` match `photos.json` exactly, with max |Δpitch| = |Δroll| = 0. vfov, heading, holding, lat/lon, alt, takenAt, tzOffset, gravity and size are all equal, and the libheif dimensions are cross-checked. The 13 ingested JPEGs match within tolerance, because sips rounded the rationals to about 1e-7 and dropped the sub-second GPS time. Synthetic gravity vectors check the sign conventions: pitch up is +, right side down is +. **ALL PASS**.
- `npx tsx out/lead/upload/region.test.ts`: **ALL PASS**. Covered: a re-pin in the same cell joins the in-flight fetch (3 Overpass calls, 0 aborted, and the joiner gets progress); an abandoned fetch is aborted after the grace period and a fresh one starts; a pre-aborted signal makes no request; bundled reuse is decided per exact position within one cell; one caller aborting doesn't affect another.
- `node out/lead/upload/verify.mjs`: **ALL PASS**.
  - JPEG with EXIF: `region-1` referenced by id (3052 peaks, 4387 trails), and IndexedDB holds no bundled-region copy.
  - HEIC through the libheif worker in Chromium: meta is exact, the image is 2048×1536 and not blank.
  - Stripped JPEG: warnings shown, a pin placed by map click, then a **re-pin 1 px away 2.5 s later while Overpass is loading**. The region still arrives: 3202 peaks and 3322 trails in 28–39 s, with no "aborted" error.
  - "Open in workspace" is clicked for the upload on screen (no pre-registration). The test waits for the upload page's `main[data-stage]` to detach, then for the workspace's `[data-ready]` with no "Loading terrain" text. A cold reload of the same id restores from IndexedDB.
  - Deleting the pinned upload removes its now-unreferenced `local-region-*` record.
  - No page errors. Page errors are logged with URL and stack.
  - Screenshots: `out/lead/upload/{jpeg,heic,nogps-before,nogps-pinned,workspace,workspace-cold}.jpg`.
  - verify.mjs stubs the Vite HMR websocket. Without that, concurrent edits full-reload the page in the middle of a test.

## Known limitations

- ~~The yawUnknown 360° search is not implemented on the solver side yet~~ (done: `integration/unknown-pose.ts`, see above).
- The OSM tile server is used directly for the pin map: light use with attribution is fine, but heavy use would need our own tiles or a provider.
- Overpass latency varies from about 5 s to over 2 minutes under load. Peaks are needed for labels; if they fail, the photo is saved with an empty region and **Retry** or `refreshLocalRegion` fills it in later.
- Uploads live only in this browser's IndexedDB. There is no server sync and no quota handling beyond the errors being surfaced.
- A `GPSImgDirectionRef = 'M'` heading is used as-is (declination is not corrected) and flagged in the UI.
- A full `npm run build` of the app has not been run; only the isolated build of decode.ts, the worker and licenses.ts (see above).
- The time-zone guess from longitude is coarse (no tz database).
- The non-secure-context hash fallback samples bytes. It is fine for ids but is not a cryptographic hash.

## Unknown-parameter flags (added after the ablation in reports/bench-ablation.md)

`meta.local` carries `yawUnknown` (no EXIF heading), `pitchRollUnknown` (no Apple gravity vector: pitch/roll are 0 placeholders) and `focalUnknown` (no 35 mm focal: f35/vfov are the iPhone default).
Solvers must free the corresponding parameters instead of trusting the placeholders. For any of them, the app's autoAlign must not auto-accept its result.
Route these uploads to the fused `/match` service when `matcherAvailable()`. Otherwise use the CPU cascade with the unknowns declared, which gave 0 false accepts across all ablation conditions.
