#!/usr/bin/env node
// Long-lived render worker for the matcher service (tools/matcher/server/app.py).
//
// Vendored from ../render.mjs (read-only there): same app-driven render (window.__engine on
// /photo/<ID>, geoRT read back explicitly, satellite drape), but
//   - keeps one headless Chromium and the last few /photo pages warm between requests,
//   - writes into a caller-supplied directory (never tools/matcher/out/renders),
//   - renders only the satellite style (hillshade doesn't help, see reports/matcher.md).
//
// Protocol: one JSON object per line on stdin, one JSON reply per line on stdout.
//   {"id":1,"cmd":"render","photoId":"IMG_7155","prior":{yaw,pitch,roll,vfov},"offsets":[-20,..],"outDir":"/tmp/x"}
//   → {"id":1,"ok":true,"meta":{...},"views":[{"tag","pose","W","H","rgb","xyz"}],"timing":{...}}
//   {"id":2,"cmd":"ping"} → {"id":2,"ok":true}
//   {"id":4,"cmd":"release","adhocId":"adhoc-…"} → drops that ad-hoc photo's cached pages
//   {"id":5,"cmd":"reload"} → reloads every cached page (test hook for the Vite-reload case)
//   {"id":3,"cmd":"align","photoId"|"adhoc","priors":[{yaw,pitch,roll,vfov},..],"fullTerrain"?}
//   → {"id":3,"ok":true,"meta":{...},"runs":[{prior, pose, score, confidence, alternatives, ms}],"timing":{...}}
//     (engine.autoAlign(true) once per prior, engine.prior swapped in memory; used by
//      tools/bench/harness for multi-seed / 360° wrappers)
// Ad-hoc photos (not in public/photos/photos.json), on render and align:
//   "adhoc": {"id":"bench-x","photoFile":"/abs/upright.jpg","meta":{lat,lon,alt,width,height,heading,
//             pitch,roll,vfov,f35},"region":{...RegionData}|null}
//   The page is opened at /photo/<id> with Playwright request interception only (no app code is
//   changed): the photos.json module gets the ad-hoc PhotoMeta appended, /photos/<id>.jpg serves
//   photoFile and /photos/<regionId>.json serves the region (empty if none).
//   "fullTerrain": true loads the tiles outside the initial viewing wedge (terrain.loadPending) and
//   re-traces the 360° horizon, once per page: needed for any yaw search beyond the prior wedge.
// Everything else (logs) goes to stderr.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { chromium } from 'playwright'

const ROOT = path.resolve(import.meta.dirname, '../../../..')
const BASE = process.env.APP_URL ?? 'http://localhost:3100'
const MATCHER_PORT = String(process.env.MATCHER_PORT ?? 8765)
const MAX_PAGES = Number(process.env.MATCHER_MAX_PAGES ?? 1) // each draped page holds ~1–1.5 GB in Chromium
const DRAPE_FULL_M = Number(process.env.MATCHER_DRAPE_FULL_M ?? 40000)
const log = (...a) => console.error('[render-worker]', ...a)

let browser = null
const pages = new Map() // photoId → { page, satReady }

async function getBrowser() {
  if (browser?.isConnected()) return browser
  browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] })
  return browser
}

function controlPoints() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'control-points.json'), 'utf8'))
  } catch {
    return {}
  }
}

async function dropPage(id) {
  const p = pages.get(id)
  pages.delete(id)
  if (p) await p.page.close().catch(() => {})
}

const PHOTOS_JSON = path.join(ROOT, 'public', 'photos', 'photos.json')

function adhocPhotoMeta(a) {
  const m = a.meta
  return {
    id: a.id,
    src: `/photos/${a.id}.jpg`,
    width: m.width,
    height: m.height,
    takenAt: m.takenAt ?? '2026-01-01T12:00:00.000Z',
    takenAtUtc: m.takenAt ?? '2026-01-01T12:00:00.000Z',
    tzOffset: null,
    lat: m.lat,
    lon: m.lon,
    alt: m.alt ?? null,
    hAccuracy: m.hAccuracy ?? null,
    heading: m.heading ?? null,
    f35: m.f35 ?? 0,
    vfov: m.vfov,
    gravity: null,
    pitch: m.pitch ?? 0,
    roll: m.roll ?? 0,
    holding: null,
    region: `${a.id}-region`,
  }
}

// page cache key: what changes the loaded page (position, size, fov, and whether a heading exists,
// which sets the initial terrain wedge). pitch/roll/yaw are per-request priors, not page state.
function pageKey(req) {
  if (!req.adhoc) return req.photoId
  const m = req.adhoc.meta
  return `adhoc:${req.adhoc.id}:${JSON.stringify([m.lat, m.lon, m.alt ?? null, m.width, m.height, m.vfov, m.heading ?? null])}`
}

// Every route handler is guarded: a fulfill that fails (page closed/reloading, request aborted) must
// never become an unhandled rejection that takes the whole worker down.
const safe = (fn) => async (r) => {
  try {
    await fn(r)
  } catch (err) {
    log(`route handler: ${String(err?.message ?? err).split('\n')[0]}`)
    await r.abort().catch(() => {})
  }
}

async function routeAdhoc(page, a) {
  if (!/^[\w.-]+$/.test(a.id)) throw new Error(`bad adhoc id ${a.id}`)
  if (!fs.existsSync(a.photoFile)) throw new Error(`adhoc photoFile missing: ${a.photoFile}`)
  // the caller deletes photoFile's temp dir after its request; a later reload of a still-open page
  // (e.g. Vite full reload) must not read the file again, so the bytes live with the page
  const photoBytes = fs.readFileSync(a.photoFile)
  const meta = adhocPhotoMeta(a)
  const bundled = JSON.parse(fs.readFileSync(PHOTOS_JSON, 'utf8')).filter((p) => p.id !== a.id)
  const list = JSON.stringify([...bundled, meta])
  const region = a.region ?? { id: meta.region, center: [meta.lat, meta.lon], photos: [], peaks: [], trails: [], waterNames: [] }
  // photos.ts imports the list as the Vite virtual module `virtual:photos` (served at /@id/__x00__virtual:photos);
  // older builds imported /photos/photos.json?import. Intercept both.
  const isVirtual = (u) => decodeURIComponent(u.pathname).includes('virtual:photos')
  await page.route(
    (u) => u.pathname.endsWith('/photos/photos.json') || isVirtual(u),
    safe((r) => {
      if (isVirtual(new URL(r.request().url())))
        return r.fulfill({ status: 200, contentType: 'application/javascript', body: `export default ${list}\n` })
      const isModule = new URL(r.request().url()).search.includes('import')
      return isModule
        ? r.fulfill({ status: 200, contentType: 'application/javascript', body: `export default ${list}\n` })
        : r.fulfill({ status: 200, contentType: 'application/json', body: list })
    }),
  )
  await page.route((u) => u.pathname === `/photos/${a.id}.jpg`, safe((r) => r.fulfill({ status: 200, body: photoBytes, contentType: 'image/jpeg' })))
  await page.route(
    (u) => u.pathname === `/photos/${meta.region}.json`,
    safe((r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...region, id: meta.region, photos: [a.id] }) })),
  )
}

async function openPage(id, adhoc = null, key = id) {
  const hit = pages.get(key)
  if (hit && !hit.page.isClosed()) {
    // an HMR reload swaps the engine; the flag lives on the engine object, so a new one is re-draped
    const alive = await hit.page.evaluate(() => !!(window.__engine?.geoRT && window.__engine.terrain && window.__engine.horizonDirs)).catch(() => false)
    if (alive) {
      pages.delete(key)
      pages.set(key, hit) // LRU bump
      return { entry: hit, loadMs: 0, warm: true }
    }
    log(`${id}: cached page lost its engine (HMR reload?), reopening`)
    await dropPage(key)
  }
  const b = await getBrowser()
  const t0 = Date.now()
  const page = await b.newPage({ viewport: { width: 1400, height: 900 } })
  const consoleTail = []
  page.on('pageerror', (e) => { log(`${id} pageerror: ${e.message}`); consoleTail.push(`pageerror: ${e.message}`.slice(0, 300)) })
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleTail.push(`${m.type()}: ${m.text()}`.slice(0, 300)); if (consoleTail.length > 12) consoleTail.shift() })
  await page.addInitScript(() => localStorage.clear())
  // the headless app must never escalate to this service itself (it would queue behind its own job)
  // the headless app must never escalate to ANY matcher instance (it would queue behind its own job,
  // or load another instance): block the service port range on loopback, whatever our own port is
  await page.route(
    (u) => ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && (u.port === MATCHER_PORT || (Number(u.port) >= 8765 && Number(u.port) <= 8769)),
    safe((r) => r.abort()),
  )
  if (adhoc) await routeAdhoc(page, adhoc)
  await page.goto(`${BASE}/photo/${id}`)
  try {
    await page.waitForSelector('[data-ready]', { state: 'attached', timeout: Number(process.env.STAGE1_PAGE_TIMEOUT_MS ?? 90000) })
  } catch (err) {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => '')
    await page.close().catch(() => {})
    throw new Error(`page for ${id} not ready: ${String(err?.message ?? err).split('\n')[0]} | body: ${body.replace(/\s+/g, ' ')} | console: ${consoleTail.slice(-6).join(' || ')}`)
  }
  const ok = await page.evaluate(() => !!window.__engine?.horizonDirs).catch(() => false)
  if (!ok) {
    const err = await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '')
    await page.close().catch(() => {})
    throw new Error(`page for ${id} has no engine/horizon after load: ${err.replace(/\s+/g, ' ')}`)
  }
  const entry = { page }
  pages.set(key, entry)
  while (pages.size > MAX_PAGES) await dropPage(pages.keys().next().value)
  log(`${id}: page loaded in ${Date.now() - t0} ms`)
  return { entry, loadMs: Date.now() - t0, warm: false }
}

// Load the tiles outside the initial wedge and re-trace the 360° horizon (once per page).
async function ensureFullTerrain(page) {
  return page.evaluate(async () => {
    const e = window.__engine
    if (e.__benchFullTerrain) return 0
    const t = performance.now()
    // don't let loadPending re-drape every tile: reset, and render() drapes again (distance-limited)
    if (e.__matcherSat) {
      e.terrain.imagery = 'none'
      e.__matcherSat = false
    }
    if (e.terrain.hasPending) await e.terrain.loadPending()
    e.horizonDirs = e.computeHorizon()
    e.geoDirty = true
    e.__benchFullTerrain = true
    return Math.round(performance.now() - t)
  })
}

async function align(req) {
  const id = req.adhoc ? req.adhoc.id : req.photoId
  if (!/^[\w.-]+$/.test(id)) throw new Error(`bad photoId ${id}`)
  const { entry, loadMs, warm } = await openPage(id, req.adhoc ?? null, pageKey(req))
  const page = entry.page
  const fullMs = req.fullTerrain ? await ensureFullTerrain(page) : 0
  const r = await page.evaluate((priors) => {
    const e = window.__engine
    const orig = { ...e.prior }
    const runs = []
    const P = (p) => (p ? { yaw: p.yaw, pitch: p.pitch, roll: p.roll, vfov: p.vfov } : null)
    try {
      for (const pr of priors) {
        e.prior = { ...orig, ...pr }
        const t = performance.now()
        const res = e.autoAlign(true)
        runs.push({
          prior: P(e.prior),
          ms: Math.round(performance.now() - t),
          pose: P(res?.pose),
          score: res?.score ?? null,
          confidence: res?.confidence ?? null,
          alternatives: (res?.alternatives ?? []).map((a) => ({ pose: P(a.pose), score: a.score, sil: a.sil ?? null, total: a.total ?? a.score })),
        })
      }
    } finally {
      e.prior = orig
    }
    return {
      runs,
      meta: { id: e.photo.id, width: e.photo.width, height: e.photo.height, aspect: e.aspect, prior: orig, eye: [e.eye.x, e.eye.y, e.eye.z], demAtCamera: e.demAtCamera, frame: { lat: e.frame.lat, lon: e.frame.lon, h: e.frame.h }, fullTerrain: !!e.__benchFullTerrain },
    }
  }, req.priors ?? [{}])
  return { ...r, timing: { loadMs, warmPage: warm, fullTerrainMs: fullMs } }
}

// Skyline cue for fusion, exactly as ../export_skyline.mjs: with engine.prior = the request prior (in
// memory), autoAlign(true) refits the sky colour model from that prior and searches; PhotoWorkspace's
// acceptance rule (as export_skyline applies it) picks the skyline pose. Exports horizonDirs,
// edge.fine / edge.fg and the refit edge.sky as float32 files. engine.prior is restored.
async function exportSkyline(page, prior, outDir) {
  const t0 = Date.now()
  const r = await page.evaluate((prior) => {
    const e = window.__engine
    if (!e.horizonDirs || !e.edge) return null
    const enc = (f) => {
      const bytes = new Uint8Array(f.buffer, f.byteOffset, f.byteLength)
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
      return btoa(bin)
    }
    const d = (a, b) => ((((a - b) % 360) + 540) % 360) - 180
    const orig = { ...e.prior }
    try {
      e.prior = { ...prior }
      const t = performance.now()
      const res = e.autoAlign(true)
      const ms = performance.now() - t
      const near = res?.alternatives?.find((a) => Math.abs(d(a.pose.yaw, e.prior.yaw)) < 4)
      const accepted = res && res.confidence > 0.2 ? 'confident' : near ? 'near-compass' : 'prior'
      const pose = accepted === 'confident' ? res.pose : accepted === 'near-compass' ? near.pose : e.prior
      return {
        w: e.edge.w,
        h: e.edge.h,
        horizon: enc(e.horizonDirs),
        fine: enc(e.edge.fine),
        fg: enc(e.edge.fg),
        sky: enc(Float32Array.from(e.edge.sky)),
        app: { prior: { ...e.prior }, pose: { ...pose }, best: res ? { ...res.pose } : null, score: res?.score ?? null, confidence: res?.confidence ?? null, accepted, ms },
      }
    } finally {
      e.prior = orig
    }
  }, prior)
  if (!r) return null
  const files = {}
  for (const k of ['horizon', 'fine', 'fg', 'sky']) {
    files[k] = path.join(outDir, `skyline_${k}.f32`)
    fs.writeFileSync(files[k], Buffer.from(r[k], 'base64'))
  }
  return { w: r.w, h: r.h, app: r.app, files, ms: Date.now() - t0 }
}

// One retry of the whole render with a fresh page when a view came back empty because the engine was
// swapped (dev-server reload) or stayed empty after an in-place retry.
async function render(req) {
  try {
    return await renderOnce(req)
  } catch (err) {
    const reload = /Execution context was destroyed|Target (page, context or browser )?closed|navigation/i.test(String(err?.message))
    if (!err?.retryable && !reload) throw err
    if (reload) await dropPage(pageKey(req))
    log(`${req.adhoc ? req.adhoc.id : req.photoId}: ${err.message}; retrying the render once with a fresh page`)
    const r = await renderOnce(req)
    r.timing.renderRetried = err.message
    return r
  }
}

async function renderOnce(req) {
  const id = req.adhoc ? req.adhoc.id : req.photoId
  if (!/^[\w.-]+$/.test(id)) throw new Error(`bad photoId ${id}`)
  const key = pageKey(req)
  const { entry, loadMs, warm } = await openPage(id, req.adhoc ?? null, key)
  const page = entry.page
  // tag this engine: a different tag later means the page reloaded (HMR) under us
  const wid = await page.evaluate(() => (window.__engine.__wid ??= Math.random().toString(36).slice(2)))
  let emptyRetries = 0
  const fullTerrainMs = req.fullTerrain ? await ensureFullTerrain(page) : 0
  const cp = req.adhoc ? null : (controlPoints()[id] ?? null)
  const meta = await page.evaluate((cp) => {
    const e = window.__engine
    const out = {
      id: e.photo.id,
      width: e.photo.width,
      height: e.photo.height,
      aspect: e.aspect,
      prior: { ...e.prior },
      eye: [e.eye.x, e.eye.y, e.eye.z],
      frame: { lat: e.frame.lat, lon: e.frame.lon, h: e.frame.h },
      gt: null,
    }
    if (cp) {
      const pins = e.controlPins(cp)
      const gt = e.solvePins(pins, e.prior, cp.solveFocal !== false)
      out.gt = {
        pose: { yaw: gt.yaw, pitch: gt.pitch, roll: gt.roll, vfov: gt.vfov },
        basis: cp.basis,
        pins: pins.map((p) => ({ world: p.world, u: p.u, v: p.v })),
      }
    }
    return out
  }, cp)

  const tImg = Date.now()
  // full-terrain (360°) pages drape only tiles within DRAPE_FULL_M: draping every tile out to 120 km
  // costs ~90 s per cold page (all requests go through Playwright interception, no HTTP cache), and
  // far tiles are a few pixels in a 1024-px render. Wedge pages drape everything, as before.
  // Readiness: after the drape, every tile in range must actually carry its imagery (a tile whose
  // fetches failed or were aborted renders as bare shaded DEM). Missing tiles are re-draped (up to 2
  // retries); the count left is reported as timing.imageryMissing.
  const drape = await page.evaluate(async (limit) => {
    const e = window.__engine
    const inRange = () => e.terrain.tiles.filter((t) => !(limit > 0) || t.distance < limit)
    const missing = () => inRange().filter((t) => !t.mesh.material.uniforms.hasMap?.value)
    let draped = false
    const all = e.terrain.tiles
    const drapeTiles = async (tiles) => {
      e.terrain.tiles = tiles
      try {
        if (e.terrain.imagery === 'satellite') e.terrain.imagery = 'none' // loadImagery returns early otherwise
        await e.terrain.loadImagery('satellite', undefined, e.renderer.capabilities.getMaxAnisotropy())
      } finally {
        e.terrain.tiles = all
        e.terrain.imagery = 'satellite'
      }
    }
    if (!e.__matcherSat) {
      await drapeTiles(inRange())
      e.__matcherSat = true
      draped = true
    }
    let retries = 0
    for (; retries < 2; retries++) {
      const m = missing()
      if (!m.length) break
      await drapeTiles(m)
    }
    return { draped, retries, missing: missing().length, tiles: inRange().length }
  }, req.fullTerrain ? (req.drapeMaxM ?? DRAPE_FULL_M) : 0)
  const draped = drape.draped
  const imageryMs = Date.now() - tImg

  const prior = { ...meta.prior, ...(req.prior ?? {}) }
  fs.mkdirSync(req.outDir, { recursive: true })
  const skyline = req.skyline ? await exportSkyline(page, prior, req.outDir) : null
  const offsets = req.views === false ? [] : (req.offsets ?? [-20, -10, 0, 10, 20])
  const poses = offsets.map((d) => ({ tag: `y${d >= 0 ? '+' : ''}${d}`, yaw: prior.yaw + d, pitch: prior.pitch, roll: prior.roll, vfov: prior.vfov }))
  const tRender = Date.now()
  const views = []
  for (const pose of poses) {
    const renderView = (pose) => page.evaluate((pose) => {
      const e = window.__engine
      const saved = e.pose
      const u = e.shared
      const keep = {
        style: u.uStyle.value,
        haze: u.uHaze.value,
        op: u.uContourOpacity.value,
        proj: u.uProjectPhoto.value,
        nf: u.uNearFade.value,
        trails: e.trails?.visible,
        pr: e.renderer.getPixelRatio(),
        size: e.renderer.getSize(new e.geoRT.texture.offset.constructor()),
      }
      const cv = e.renderer.domElement
      const cssW = cv.style.width
      const cssH = cv.style.height
      const bw = cv.width
      const bh = cv.height
      e.pose = { yaw: pose.yaw, pitch: pose.pitch, roll: pose.roll, vfov: pose.vfov }
      e.renderGeometry()
      const W = e.geoRT.width
      const H = e.geoRT.height
      const g = new Float32Array(W * H * 4)
      e.renderer.readRenderTargetPixels(e.geoRT, 0, 0, W, H, g)
      const xyz = new Float32Array(W * H * 3)
      for (let y = 0; y < H; y++) {
        const src = (H - 1 - y) * W
        for (let x = 0; x < W; x++) {
          const i = (src + x) * 4
          const o = (y * W + x) * 3
          if (g[i + 3] > 0) {
            xyz[o] = g[i]
            xyz[o + 1] = g[i + 1]
            xyz[o + 2] = g[i + 2]
          }
        }
      }
      const bytes = new Uint8Array(xyz.buffer)
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
      const xyzB64 = btoa(bin)
      if (e.trails) e.trails.visible = false
      e.renderer.setPixelRatio(1)
      e.renderer.setSize(W, H, false)
      e.renderer.setRenderTarget(null)
      e.renderer.setClearColor(0xb9cde0, 1)
      u.uProjectPhoto.value = 0
      u.uNearFade.value = 0
      u.uContourOpacity.value = 1
      u.uStyle.value = 1
      u.uHaze.value = 0.6
      e.renderer.clear()
      e.renderer.render(e.scene, e.cam)
      const sat = cv.toDataURL('image/jpeg', 0.92)
      u.uStyle.value = keep.style
      u.uHaze.value = keep.haze
      u.uContourOpacity.value = keep.op
      u.uProjectPhoto.value = keep.proj
      u.uNearFade.value = keep.nf
      if (e.trails) e.trails.visible = keep.trails
      e.renderer.setPixelRatio(keep.pr)
      e.renderer.setSize(keep.size.x, keep.size.y, false)
      cv.width = bw
      cv.height = bh
      cv.style.width = cssW
      cv.style.height = cssH
      e.pose = saved
      e.geoDirty = true
      e.requestRender()
      return { W, H, xyzB64, sat }
    }, pose)
    // test hook (MATCHER_DEBUG_HOOKS=1): simulate a dev-server reload right before view N of the first attempt
    if (process.env.MATCHER_DEBUG_HOOKS === '1' && req.debugReloadBeforeView === poses.indexOf(pose) && !req.__debugDone) {
      req.__debugDone = true
      await page.reload({ waitUntil: 'load' }).catch(() => {})
      await page.waitForFunction(() => !!window.__engine?.geoRT, null, { timeout: 120000 }).catch(() => {})
    }
    let r = await renderView(pose)
    const countTerrain = (r) => {
      const b = Buffer.from(r.xyzB64, 'base64')
      const ff = new Float32Array(b.buffer, b.byteOffset, b.length / 4)
      let n = 0
      for (let i = 0; i < ff.length; i += 97) if (ff[i] !== 0) n++
      return { buf: b, nz: n }
    }
    let { buf, nz } = countTerrain(r)
    if (nz === 0 && !req.allowEmpty) {
      // Why is a view empty? Either the engine was swapped under us (a Vite HMR/full reload of the
      // shared dev server mid-render: the page has a new __engine without our drape) or the view has
      // no terrain in it at all. Diagnose, then retry once: in place if the engine is the same, or with
      // a fresh page (whole render) if it was swapped.
      const nowWid = await page.evaluate(() => window.__engine?.__wid ?? null).catch(() => null)
      if (nowWid !== wid) {
        await dropPage(key)
        const err = new Error(`empty render for ${pose.tag}: engine swapped mid-render (dev-server reload)`)
        err.retryable = true
        throw err
      }
      log(`${id}: empty render for ${pose.tag} on a live engine; retrying the view once`)
      await new Promise((res) => setTimeout(res, 500))
      r = await renderView(pose)
      ;({ buf, nz } = countTerrain(r))
      emptyRetries++
    }
    if (nz === 0 && req.allowEmpty) continue // narrow fans: a view can be all sky (caller skips it)
    if (nz === 0) {
      await dropPage(key) // dead engine: force a fresh page next time
      const err = new Error(`empty render for ${pose.tag} (no terrain in view after a retry)`)
      err.retryable = true
      throw err
    }
    const xyzPath = path.join(req.outDir, `${pose.tag}_xyz.f32`)
    const rgbPath = path.join(req.outDir, `${pose.tag}_sat.jpg`)
    fs.writeFileSync(xyzPath, buf)
    fs.writeFileSync(rgbPath, Buffer.from(r.sat.split(',')[1], 'base64'))
    const { tag, ...p } = pose
    views.push({ tag, pose: p, W: r.W, H: r.H, rgb: rgbPath, xyz: xyzPath })
  }
  return { meta, views, skyline, timing: { loadMs, fullTerrainMs, imageryMs, skylineMs: skyline?.ms ?? 0, renderMs: Date.now() - tRender, warmPage: warm, draped, emptyViewRetries: emptyRetries, imageryRetries: drape.retries, imageryMissing: drape.missing, imageryTiles: drape.tiles } }
}

// Drop the cached pages of an ad-hoc photo (called by app.py when its request finishes).
async function release(req) {
  const id = req.adhoc?.id ?? req.adhocId
  let n = 0
  for (const key of [...pages.keys()]) {
    if (key.startsWith(`adhoc:${id}:`)) {
      await dropPage(key)
      n++
    }
  }
  return n
}

// Test hook: reload every cached page (what a Vite full reload does to a warm page).
async function reloadPages() {
  const out = []
  for (const [key, p] of pages) {
    const ok = await p.page.reload({ waitUntil: 'load', timeout: 60000 }).then(() => true).catch((e) => String(e?.message ?? e).split('\n')[0])
    out.push({ key, ok })
  }
  return { reloaded: out }
}

// Last line of defence: log, never exit, on stray async errors (a dead worker 503s the in-flight request).
process.on('unhandledRejection', (e) => log(`unhandledRejection: ${String(e?.message ?? e).split('\n')[0]}`))
process.on('uncaughtException', (e) => log(`uncaughtException: ${String(e?.message ?? e).split('\n')[0]}`))

const rl = readline.createInterface({ input: process.stdin })
let chain = Promise.resolve()
rl.on('line', (line) => {
  chain = chain.then(async () => {
    let req
    try {
      req = JSON.parse(line)
    } catch {
      return
    }
    let reply
    try {
      if (req.cmd === 'ping') reply = { ok: true }
      else if (req.cmd === 'render') reply = { ok: true, ...(await render(req)) }
      else if (req.cmd === 'align') reply = { ok: true, ...(await align(req)) }
      else if (req.cmd === 'release') reply = { ok: true, released: await release(req) }
      else if (req.cmd === 'reload') reply = { ok: true, ...(await reloadPages(req)) }
      else reply = { ok: false, error: `unknown cmd ${req.cmd}` }
    } catch (err) {
      reply = { ok: false, error: String(err?.message ?? err).split('\n')[0] }
    }
    process.stdout.write(`${JSON.stringify({ id: req.id, ...reply })}\n`)
  })
})
// Shut down with the parent: stdin EOF (the Python server died, even by SIGKILL) or SIGTERM/SIGINT
// (a restart). Close Chromium first so no headless browser outlives this worker; don't wait for an
// in-flight command, and exit after 3 s even if the browser won't close.
let shuttingDown = false
async function shutdown(why) {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutting down (${why})`)
  setTimeout(() => process.exit(0), 3000).unref()
  await browser?.close().catch(() => {})
  process.exit(0)
}
rl.on('close', () => shutdown('stdin closed'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
log('ready')
