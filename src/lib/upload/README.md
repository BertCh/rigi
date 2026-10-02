# src/lib/upload: browser photo upload

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
| `src/lib/upload/coach.ts` | Location coaching (pure): which sensors a file carried and how to record the missing ones next time (iOS settings path) |
| `src/lib/upload/SlippyMap.tsx` | Dependency-free OSM raster map: click to pin, drag to pan, wheel or double-click to zoom. Draws an accuracy circle and a heading wedge |
| `src/lib/upload/libheif.d.ts` | Typings for `libheif-js/libheif-wasm/libheif-bundle.mjs` |
| `src/routes/upload.tsx` | `/upload` route (ssr: false) |
| `src/lib/upload/__tests__/*.spec.ts(x)` | Vitest specs: EXIF, decode, region fetch sharing/abort/bundled reuse, store, licences, coach |

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

## Integration

- `photos.ts` `registerLocalPhoto(meta, region)`; `getPhoto` checks local photos first. The `photo.$id.tsx` loader lazy-loads this module for an unknown `local-*` id and calls `ensureLocalPhotoRegistered(id)`, so cold reloads restore from IndexedDB.
- No heading: `src/lib/integration/unknown-pose.ts` runs a 360° yaw search (CPU cascade, then the in-browser fused matcher in ad-hoc mode), and the Heading slider spans 0–360° when `unknowns.yaw`.
- Pinned photos have `alt: null`, so the engine uses DEM + 1.8 m. `registerWithWorkspace` passes `null` for bundled region ids so `loadRegion('region-1')` still fetches the live JSON.

## Behaviour details

- **EXIF**: exifr (full build) reads HEIC and JPEG in the browser. The code uses the same two parses as ingest.mjs: translated values plus makerNote, and raw strings for the time (GPS UTC first, else DateTimeOriginal + OffsetTimeOriginal, else File.lastModified with `timeSource: 'file'`). The Apple MakerNote tag 0x0008 gives gravity, which gives pitch, roll and holding via the same candidate search as ingest. vfov comes from `f35 * diag / 43.2666` on the displayed, resized size. f35 defaults to 26 when missing. GPSAltitudeRef = 1 (below sea level) is honoured. ingest ignores it, which makes no difference in the Alps.
- **Implausible values** (2026-10-02): GPS at exactly (0, 0) or out of range reads as no GPS (`diagnostics.gpsRejected`, pin needed); a gravity vector with |g| outside 0.5–2 g or non-finite reads as no gravity (`pitchRollUnknown`); FocalLengthIn35mmFormat outside 5–3000 mm reads as unknown (`focalUnknown`, default 26); a GPSDateStamp before 1980 falls through to DateTimeOriginal; headings are wrapped to [0, 360); a square image lets gravity pick the holding among all four. In-range values are unchanged (the 19 bundled HEICs give identical metas).
- **Decode**: HEIC is detected by `ftyp` brand, not by file name. libheif applies `irot`, so the output is upright; HEIC EXIF Orientation is never applied a second time. An upright JPEG that is already ≤ 2048 px is stored byte-for-byte (`decoder: 'passthrough'`). Anything else is re-encoded as JPEG q0.86. Thumbnails are 360 px.
- **Time zone**: a DateTimeOriginal without OffsetTime* and without GPS time (typical for non-Apple cameras) gets `timeSource: 'exif-local'`. Once a position is known, the zone is guessed as `round(lon / 15)` h (`tzEstimated: true`, `tzOffset` set) and takenAt is shifted. This ignores political zones and DST, so it can be about 1 h off in Alpine summer; the UI warns about it. Before a position is known, the time is read as UTC, as ingest.mjs does.
- **No GPS** (iOS Safari photo picker since 16.4): the page explains Options → Location in the picker, or Files / AirDrop, and moves the map above the preview. The user clicks the map or types "lat, lon". Other flags shown: missing heading (360° search), magnetic heading, no gravity (pitch/roll 0), unknown lens, and GPS accuracy worse than 50 m.
- **Region**: the order is memory → a bundled `public/photos/region-*.json` when the photo's exact position is within 6 km of that region's centre → IndexedDB → Overpass. A bundled region is only referenced (`meta.region = 'region-1'`), never copied into IndexedDB, and never seeded into photos.ts `regionCache`, so it stays current when ingest regenerates it. The memo is keyed `bundled:<id>` for bundled hits and by the 0.05° cell otherwise, so a second photo in the same cell but beyond 6 km does not inherit the bundled region. Concurrent callers share one fetch, which runs on its own AbortController. Aborting a caller's `signal` only detaches that caller. The shared fetch is aborted only when no caller has been left for `ABANDON_GRACE_MS` (1.5 s), so a re-pin inside the same cell (effect cleanup aborts, then re-requests) rejoins the fetch already in flight. Overpass is tried at overpass-api.de (retried once after a fast 429/504), then private.coffee, then kumi.systems, with 45 s timeouts per request. Peaks are fetched, then water; trails are fetched on demand by `fetchRegionTrails` and stored with `trailsFetched`. An older cached region is used if the network fails. The UI has Skip and Retry buttons. Region ids are `local-region-<lat>_<lon>` on a 0.05° grid. The trail bbox is widened by 3 km to cover the snap offset.

## HEIC dependency and licence

**`libheif-js@1.23.2`** (a runtime dependency) is **LGPL-3.0**: an Emscripten build of strukturag/libheif (LGPL-3.0) with the libde265 HEVC decoder (LGPL-3.0) embedded.

How the LGPL is met:
- **Separate, replaceable file.** `decode.ts` imports `libheif-js/libheif-wasm/libheif-bundle.mjs?url`, so Vite emits the unmodified 1,989,119-byte bundle as a single asset (`assets/libheif-bundle-<hash>.mjs`). It is not minified or inlined. The worker loads it with a runtime `import()` of that URL, and so does the main-thread fallback, so there is one copy. An isolated `vite build` gives `heic.worker-<hash>.js` at 641 bytes plus that one libheif file. Served from `vite preview`, headless Chromium decoded the portrait `IMG_7068.HEIC` to 1536×2048 through the worker.
- **Notice.** `/upload` has a "Credits and licences" footer: OSM/ODbL attribution, libheif and libde265 with versions, licence and source links, a link to the libheif file, and the full LGPL v3 + GPL v3 text (`libheif-wasm/LICENSE`, imported `?raw`).

The worker builds its importer with `new Function('u', 'return import(u)')`. A visible non-literal `import()` makes Vite dev inject `/@vite/client` into the worker, and that client's CSS-HMR handler throws "document is not defined" inside the worker. A future Content-Security-Policy would therefore need `'unsafe-eval'`. The alternative is to serve libheif from `public/` as a classic script.

If a browser's classic workers can't run dynamic `import()`, the decode falls back to the main thread, which works but blocks the UI for about 1 s. If LGPL is unacceptable, remove the dependency: `decodeImage` then throws `HeicUnsupportedError`, and the route shows the "export as JPEG / use Safari" message. The bundle is about 2 MB and loads only when a HEIC fails native decode (Chrome and Firefox; Safari decodes natively).

## Verification

- Unit: `npx vitest run src/lib/upload` (pure CPU specs listed above; part of the fast `unit` row).
- 2026-09-29 browser run (Playwright `verify.mjs`, local-only under `out/lead/upload/`, gitignored): JPEG with EXIF reuses `region-1` by id; HEIC decodes through the libheif worker; a stripped JPEG takes a map pin and a re-pin during the Overpass load still gets its region; "Open in workspace" and a cold reload restore from IndexedDB; deleting a pinned upload removes its unreferenced `local-region-*`. The EXIF port matched `photos.json` exactly on 13 HEICs (|Δpitch| = |Δroll| = 0). Not re-run since.

## Known limitations

- The OSM tile server is used directly for the pin map: light use with attribution is fine, but heavy use would need our own tiles or a provider.
- Overpass latency varies from about 5 s to over 2 minutes under load. Peaks are needed for labels; if they fail, the photo is saved with an empty region and **Retry** or `refreshLocalRegion` fills it in later.
- Uploads live only in this browser's IndexedDB. There is no server sync and no quota handling beyond the errors being surfaced.
- A `GPSImgDirectionRef = 'M'` heading is used as-is (declination is not corrected) and flagged in the UI.
- The time-zone guess from longitude is coarse (no tz database).
- The non-secure-context hash fallback samples bytes. It is fine for ids but is not a cryptographic hash.

## Unknown-parameter flags (added after the ablation in reports/bench-ablation.md)

`meta.local` carries `yawUnknown` (no EXIF heading), `pitchRollUnknown` (no Apple gravity vector: pitch/roll are 0 placeholders) and `focalUnknown` (no 35 mm focal: f35/vfov are the iPhone default).
Solvers must free the corresponding parameters instead of trusting the placeholders. For any of them, the app's autoAlign must not auto-accept its result.
`integration/unknown-pose.ts` runs the CPU cascade with the unknowns declared (0 false accepts across all ablation conditions), then the in-browser fused matcher when `matcherAvailable()` (`src/lib/matcher-client.ts`).
