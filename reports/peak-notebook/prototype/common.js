// shared helpers for the v4 prototypes
const NS = "http://www.w3.org/2000/svg";
const RAD = Math.PI / 180;
const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) { const v = attrs[k]; if (typeof v === "string" && v.startsWith("var(") && /^(fill|stroke)$/.test(k)) e.style.setProperty(k, v); else e.setAttribute(k, v); } if (parent) parent.appendChild(e); return e; };
const text = (parent, x, y, str, attrs = {}) => { const t = el("text", { x, y, ...attrs }, parent); t.textContent = str; return t; };
// resolve a role token to a plain rgb() colour in the node's theme scope (SVG attributes reject color-mix/var)
const tok = (_node, v) => `var(${v})`; // resolved by CSS in the element's own theme scope
function rng(seed) { let s = 0; for (const c of seed) s = (s * 31 + c.charCodeAt(0)) | 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function penLine(x1, y1, x2, y2, seed, j = 0.7) { const r = rng(seed); const n = Math.max(2, Math.round(Math.hypot(x2 - x1, y2 - y1) / 18)); let d = ""; for (let i = 0; i <= n; i++) { const t = i / n, k = i && i < n ? 1 : 0.3; d += (i ? "L" : "M") + (x1 + (x2 - x1) * t + (r() - .5) * j * k).toFixed(1) + " " + (y1 + (y2 - y1) * t + (r() - .5) * j * k).toFixed(1); } return d; }
function penCircle(cx, cy, rx, ry, seed) { const r = rng(seed); let d = ""; const a0 = r() * 6; for (let i = 0; i <= 26; i++) { const a = a0 + i / 24 * Math.PI * 2.08, k = 1 + (r() - .5) * .06; d += (i ? "L" : "M") + (cx + Math.cos(a) * rx * k).toFixed(1) + " " + (cy + Math.sin(a) * ry * k).toFixed(1); } return d; }
function penArrow(x1, y1, x2, y2, bend = 14) { const L = Math.hypot(x2 - x1, y2 - y1) || 1; const mx = (x1 + x2) / 2 - (y2 - y1) / L * bend, my = (y1 + y2) / 2 + (x2 - x1) / L * bend; const a = Math.atan2(y2 - my, x2 - mx), h = 8; return `M${x1} ${y1}Q${mx} ${my} ${x2} ${y2}M${x2 - h * Math.cos(a - .45)} ${y2 - h * Math.sin(a - .45)}L${x2} ${y2}L${x2 - h * Math.cos(a + .45)} ${y2 - h * Math.sin(a + .45)}`; }
// pinhole projector validated against solvedRows (roll sign -1); working frame 800 wide
function projector(S, w, h) { const cx = w / 2, cy = h / 2; return (az, elv) => {
  const daz = ((az - S.yaw + 540) % 360 - 180) * RAD, e = elv * RAD, p = S.pitch * RAD, r = -S.roll * RAD;
  const x = Math.cos(e) * Math.sin(daz), z = Math.cos(e) * Math.cos(daz), y = Math.sin(e);
  const z2 = z * Math.cos(p) + y * Math.sin(p), y2 = y * Math.cos(p) - z * Math.sin(p);
  const u = S.f * x / z2, v = -S.f * y2 / z2;
  return [cx + u * Math.cos(r) - v * Math.sin(r), cy + u * Math.sin(r) + v * Math.cos(r)]; }; }
const gapsOf = (w, min = 12) => { const g = []; let st = -1; for (let c = 0; c <= w.length; c++) { const off = c < w.length && w[c] <= 0; if (off && st < 0) st = c; if (!off && st >= 0) { if (c - st > min) g.push([st, c]); st = -1; } } return g; };
const polyline = (pts) => pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join("");
// skyline band rows for a photo: 10th–90th percentile of voted rows, padded
function bandOf(P, padFrac = 0.2, minRows = 160) {
  const ys = P.rows.filter((_, i) => P.weight[i] > 0).sort((a, b) => a - b);
  const lo = ys[Math.floor(ys.length * .1)], hi = ys[Math.floor(ys.length * .9)];
  let a = lo - P.h * padFrac * 0.8, b = hi + P.h * padFrac * 1.4;
  if (b - a < minRows) { const m = (a + b) / 2; a = m - minRows / 2; b = m + minRows / 2; }
  a = Math.max(0, a); b = Math.min(P.h, b); return [a, b];
}
