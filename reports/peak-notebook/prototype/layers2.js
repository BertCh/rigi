// v5: one visual form per sheet, all from the followed photo's measured run
const paperBg = (svg) => el("rect", { width: W, height: H, fill: "var(--gb-paper)" }, svg);
Object.assign(LAYERS, {
  "camera-prior"(svg, P, id, ink) { paperBg(svg); const cx = 110, cy = H / 2, R = 58;
    el("path", { d: penCircle(cx, cy, R, R, "cp"), stroke: ink("--gb-secondary"), "stroke-width": 1, fill: "none" }, svg);
    ["N", "E", "S", "W"].forEach((c, i) => text(svg, cx + Math.sin(i * Math.PI / 2) * (R + 10), cy - Math.cos(i * Math.PI / 2) * (R + 10) + 4, c, { "text-anchor": "middle", class: "micro", fill: c === "N" ? ink("--gb-route") : ink("--gb-secondary") }));
    const arm = (deg, color, dash) => el("line", { x1: cx, y1: cy, x2: cx + Math.sin(deg * RAD) * R, y2: cy - Math.cos(deg * RAD) * R, stroke: color, "stroke-width": 2, "stroke-dasharray": dash || "" }, svg);
    arm(P.sensor.heading, ink("--gb-route"), "5 4"); arm(P.solved.yaw, ink("--gb-measure"));
    text(svg, 200, 58, `phone  ${P.sensor.heading.toFixed(1)}°`, { class: "micro", fill: ink("--gb-route") });
    text(svg, 200, 78, `terrain ${P.solved.yaw.toFixed(1)}°`, { class: "micro", fill: ink("--gb-measure") });
    text(svg, 200, 104, `${P.solved.delta.yaw > 0 ? "+" : ""}${P.solved.delta.yaw.toFixed(1)}°`, { "font-size": 24, "font-weight": 300, "font-family": "GB Sans", fill: ink("--gb-ink") }); },
  "dem-horizon"(svg, P, id, ink) { paperBg(svg); const az0 = P.profile[0].az, az1 = P.profile.at(-1).az; const X = (az) => (az - az0) / (az1 - az0) * W;
    const els = P.profile.map((p) => p.el); const lo = Math.min(...els) - 1, hi = Math.max(...els) + .5; const Y = (e) => H - 22 - (e - lo) / (hi - lo) * (H - 40);
    const yaw = P.solved.yaw, hf = P.solved.hfov / 2; el("rect", { x: X(yaw - hf), y: 0, width: X(yaw + hf) - X(yaw - hf), height: H, fill: "var(--gb-paper-deep)" }, svg);
    const d = polyline(P.profile.map((p) => [X(p.az), Y(p.el)])); el("path", { d: d + `L${W} ${H}L0 ${H}Z`, fill: "url(#hz)" }, svg);
    const pat = el("pattern", { id: "hz", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(-45)" }, svg); el("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: ink("--gb-terrain"), "stroke-width": 1, "stroke-opacity": .5 }, pat);
    el("path", { d, stroke: ink("--gb-ink"), "stroke-width": 1.6, fill: "none" }, svg);
    text(svg, X(yaw), 14, "photo frame", { "text-anchor": "middle", class: "micro", fill: ink("--gb-secondary") }); },
  "viewport-inference"(svg, P, id) { const { k, ox, oy } = band(svg, id, P, { id }); halo(P, P.priorRows, svg, k, ox, oy, "#bf2233", { "stroke-dasharray": "6 4" }); halo(P, P.solvedRows, svg, k, ox, oy, "#30626b");
    const c = 560; const y1 = oy + P.priorRows[c] * k, y2 = oy + P.solvedRows[c] * k; const x = ox + c * k; el("path", { d: penArrow(x - 30, y1 - 6, x + 10, y2 - 4, 10), stroke: "#fff", "stroke-width": 1.6, fill: "none" }, svg); },
  "pose-estimate"(svg, P, id, ink) { paperBg(svg); const bw = W / 200; let n = 0, inl = 0;
    for (let i = 0; i < 200; i++) { const c = i * 4; if (P.weight[c] <= 0) continue; const r = Math.abs(P.rows[c] - P.solvedRows[c]); n++; const ok = r < 5; if (ok) inl++; const h = Math.min(H - 40, r * 6); el("rect", { x: i * bw, y: H - 24 - h, width: bw * .7, height: h, fill: ok ? "var(--gb-result)" : "var(--gb-route)" }, svg); }
    el("line", { x1: 0, x2: W, y1: H - 24 - 30, y2: H - 24 - 30, stroke: ink("--gb-secondary"), "stroke-dasharray": "3 3" }, svg); text(svg, W, H - 24 - 34, "5 px", { "text-anchor": "end", class: "micro", fill: ink("--gb-secondary") });
    text(svg, 0, H - 8, "|photo − terrain| per column, once solved", { class: "micro", fill: ink("--gb-secondary") }); },
  "accept-rule"(svg, P, id, ink) { paperBg(svg); const x0 = 24, x1 = W - 24, y = 84, X = (v) => x0 + v * (x1 - x0);
    el("line", { x1: x0, x2: x1, y1: y, y2: y, stroke: ink("--gb-secondary"), "stroke-width": 1 }, svg); [0, .5, 1].forEach((v) => text(svg, X(v), y + 20, v.toFixed(1), { "text-anchor": "middle", class: "micro", fill: ink("--gb-secondary") }));
    Object.entries(DATA.photos).forEach(([pid, Q]) => { const on = pid === id; el("circle", { cx: X(Q.solved.confidence), cy: y - 10 - (on ? 0 : 0), r: on ? 6 : 3.5, fill: Q.solved.accepted ? "var(--gb-result)" : "var(--gb-route)", stroke: on ? ink("--gb-ink") : "none", "stroke-width": 1.5 }, svg); });
    const v = P.solved.confidence; text(svg, X(v), 40, `${P.solved.accepted ? "✓ shown" : "✗ refused"} · ${v.toFixed(2)}`, { "text-anchor": "middle", class: "micro", fill: P.solved.accepted ? ink("--gb-result") : ink("--gb-route") }); },
  "tap-a-peak"(svg, P, id) { const { k, ox, oy } = band(svg, id, P, { id }); P.peaks.filter((p) => p.labelled && p.solved).map((p) => ({ p, x: ox + p.solved[0] * k, y: oy + p.solved[1] * k })).filter((o) => o.x > 24 && o.x < W - 24 && o.y > 20 && o.y < H - 20).slice(0, 3).forEach((o, i) => { el("path", { d: penCircle(o.x, o.y, 12, 12, "tap" + i), stroke: "#fff", "stroke-width": 1.8, fill: "none" }, svg); el("circle", { cx: o.x, cy: o.y, r: 2.4, fill: "#fff" }, svg); text(svg, o.x + 16, o.y - 10, String(i + 1), { class: "hand", "font-size": 16, fill: "#fff", style: "text-shadow:0 1px 2px rgba(0,0,0,.7)" }); }); },
  "baseline-pipeline"(svg, P, id, ink) { paperBg(svg); const st = [["terrain", P.ms.terrain, "--gb-terrain"], ["horizon", P.ms.horizon, "--gb-terrain"], ["skyline", P.ms.skyline, "--gb-measure"], ["solve", P.ms.solve, "--gb-result"]]; const tot = st.reduce((a, s) => a + s[1], 0); let x = 0;
    st.forEach(([name, ms, c], i) => { const w = ms / tot * W; el("rect", { x, y: 56, width: Math.max(2, w - 2), height: 30, fill: `var(${c})`, "fill-opacity": i === 1 ? .55 : .9 }, svg); text(svg, i < 2 ? x + 4 : Math.min(x, W - 70), i < 2 ? 50 : 106 + (i - 2) * 14, `${name} ${ms} ms`, { class: "micro", fill: ink("--gb-ink") }); x += w; });
    text(svg, 0, 24, `${tot} ms on one CPU core`, { class: "micro", fill: ink("--gb-secondary") }); },
  "dem-source"(svg, P, id, ink) { demPatch(svg, P, ink); const cx = W / 2, cy = H / 2; [[24, "z13"], [70, "z11"], [150, "z10"]].forEach(([r, z]) => { el("circle", { cx, cy, r, fill: "none", stroke: "#fff", "stroke-opacity": .8, "stroke-dasharray": "3 3" }, svg); text(svg, cx + r * .72 + 4, cy - r * .72, z, { class: "micro", fill: "#fff" }); }); },
  "terrain-sampler"(svg, P, id, ink) { el("image", { href: P.dem.src, x: -W * 1.5, y: -W * 1.5 + H / 2 - W / 2 + W / 2, width: W * 4, height: W * 4, preserveAspectRatio: "none" }, svg); const cx = W / 2, cy = H / 2;
    el("path", { d: `M${cx - 14} ${cy}h28M${cx} ${cy - 14}v28`, stroke: "#fff", "stroke-width": 1.4 }, svg); text(svg, cx + 18, cy - 8, `heightAt() = ${P.gps.ground.toFixed(1)} m`, { class: "micro", fill: "#fff", style: "text-shadow:0 1px 2px #000" }); },
  "eye-rule"(svg, P, id, ink) { paperBg(svg); const g = P.gps.ground, a = P.gps.alt; const lo = g - 6, hi = Math.max(a, g + 1.6) + 6; const Y = (e) => H - 12 - (e - lo) / (hi - lo) * (H - 24);
    el("rect", { x: 0, y: Y(g), width: W, height: H - Y(g), fill: "var(--gb-paper-deep)" }, svg); el("line", { x1: 0, x2: W, y1: Y(g), y2: Y(g), stroke: ink("--gb-terrain"), "stroke-width": 1.6 }, svg);
    const row = (e, label, c, dash) => { el("line", { x1: 120, x2: W - 10, y1: Y(e), y2: Y(e), stroke: c, "stroke-width": 1.2, "stroke-dasharray": dash || "" }, svg); text(svg, W - 10, Y(e) - 4, label, { "text-anchor": "end", class: "micro", fill: c }); };
    row(g, `DEM ground ${g.toFixed(1)} m`, ink("--gb-terrain")); row(g + 1.6, "ground + 1.6 m", ink("--gb-secondary"), "3 3"); row(a, `GPS ${a.toFixed(1)} m`, ink("--gb-measure"), "6 3");
    const eye = Math.max(a, g + 1.6); el("circle", { cx: 80, cy: Y(eye), r: 5, fill: "var(--gb-route)" }, svg); text(svg, 92, Y(eye) + 4, "eye", { class: "micro", fill: ink("--gb-route") }); },
  peak(svg, P, id) { const { k, ox, oy } = band(svg, id, P, { id }); const c = P.peaks.filter((p) => p.labelled && p.solved).map((p) => ({ p, x: ox + p.solved[0] * k, y: oy + p.solved[1] * k })).filter((o) => o.x > 90 && o.x < W - 90 && o.y > 50).sort((a, b) => b.p.ele - a.p.ele)[0];
    if (!c) return; el("line", { x1: c.x, x2: c.x, y1: c.y - 34, y2: c.y - 3, stroke: "#fff", "stroke-width": 1 }, svg); el("circle", { cx: c.x, cy: c.y, r: 3, fill: "#fff" }, svg);
    text(svg, c.x, c.y - 50, c.p.name, { "text-anchor": "middle", "font-size": 13, "font-weight": 600, fill: "#fff", "font-family": "GB Sans", style: "text-shadow:0 1px 3px rgba(0,0,0,.7)" }); text(svg, c.x, c.y - 38, `${Math.round(c.p.ele)} m · ${(c.p.distance / 1000).toFixed(0)} km`, { "text-anchor": "middle", class: "micro", fill: "#fff", style: "text-shadow:0 1px 3px rgba(0,0,0,.7)" }); },
  "dem-anchoring"(svg, P, id, ink) { paperBg(svg); const pts = P.terrain.points.filter((p) => p[0] > 30); const dmax = pts.at(-1)[0]; const xs = (d) => 16 + Math.log(d / 30) / Math.log(dmax / 30) * (W - 32); const lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1])); const ys = (e) => H - 28 - (e - lo) / (hi - lo) * (H - 52);
    el("path", { d: polyline(pts.map((p) => [xs(p[0]), ys(p[1])])), stroke: ink("--gb-terrain"), "stroke-width": 1.6, fill: "none" }, svg); [100, 1000, 10000].forEach((m) => { if (m > dmax) return; el("line", { x1: xs(m), x2: xs(m), y1: H - 22, y2: H - 16, stroke: ink("--gb-secondary") }, svg); text(svg, xs(m), H - 4, m >= 1000 ? `${m / 1000} km` : `${m} m`, { "text-anchor": "middle", class: "micro", fill: ink("--gb-secondary") }); });
    text(svg, 16, 16, "ground along the view, log distance", { class: "micro", fill: ink("--gb-secondary") }); },
  rigi(svg) { el("image", { href: "/demo/shots/demo-01-overlay.jpg", x: -W * .45, y: -170, width: W * 1.9, height: W * 1.9 * .75, preserveAspectRatio: "none" }, svg); },
  "photo-workspace"(svg, P, id) { el("image", { href: "/demo/photos/demo-01.jpg", x: 0, y: -90, width: W, height: 300, preserveAspectRatio: "none" }, svg); const c = el("clipPath", { id: "pw" }, svg); el("rect", { x: W * .52, y: 0, width: W, height: H }, c); const g = el("g", { "clip-path": "url(#pw)" }, svg); el("image", { href: "/demo/shots/demo-01-overlay.jpg", x: 0, y: -90, width: W, height: 300, preserveAspectRatio: "none" }, g); el("line", { x1: W * .52, x2: W * .52, y1: 0, y2: H, stroke: "#fff", "stroke-width": 2 }, svg); },
});
Object.assign(VALUE, {
  "accept-rule": (P) => `confidence ${P.solved.confidence.toFixed(2)} · ${P.solved.accepted ? "shown" : "refused"}`,
  "dem-horizon": (P) => `±${((P.profile.at(-1).az - P.profile[0].az) / 2).toFixed(0)}° around the view · ${P.ms.horizon} ms`,
  "eye-rule": (P) => `eye ${Math.max(P.gps.alt, P.gps.ground + 1.6).toFixed(1)} m · ${(P.gps.alt - P.gps.ground).toFixed(1)} m above ground`,
  "baseline-pipeline": (P) => `${P.ms.terrain + P.ms.horizon + P.ms.skyline + P.ms.solve} ms end to end`,
});
const TAGEBUCH = [
  (P) => `compass said <span class="mono">${P.sensor.heading.toFixed(1)}°</span>, terrain said <span class="mono">${P.solved.yaw.toFixed(1)}°</span>, ${P.solved.accepted ? "shown at" : "refused at"} <span class="mono">${P.solved.confidence.toFixed(2)}</span>`,
  (P) => `GPS put the eye <span class="mono">${(P.gps.alt - P.gps.ground).toFixed(1)} m</span> above the DEM ground at <span class="mono">${P.gps.ground.toFixed(1)} m</span>`,
  () => `one pose, three uses: the overlay, the roll, the scene`,
];
