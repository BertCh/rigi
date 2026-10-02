# src/lib/gpu/horizon: GPU skyline march and its precision stages

| File | What it does |
|---|---|
| `horizon.wgsl.ts`, `index.ts`, `graph.ts` | The ray march (`computeHorizonGpu`), one invocation per (eye, azimuth), on a core `ComputeGraph` per chunk. Twin: `horizon-fast/march.ts`. `opts.precision` selects the tan → degrees stage (below) |
| `dirs-cpu.ts` | The worker's f64 skyline-direction stage (D8), moved verbatim: `skylineDirsF64`, the lazy `SkylineF64`, `GPU_COLUMNS`. The reference for the certified path |
| `certified-cpu.ts` | Certified f32, the pure half: tracked error bounds on the shared double-f32 emulation, packed layouts, the three stages, the CPU finish (tie path) |
| `certified.wgsl.ts` | The same stages in WGSL, line for line |
| `certified.ts` | The GPU host: `horizonElevations`, `skylineDirs` (opt-in `precision`) |
| `../precision/df32.ts`, `../precision/ieee-probe.ts` | Shared with other certified-f32 stages: the f32-machine emulation, double-f32 arithmetic in TS and WGSL (`DF32_WGSL`), their budgets, and the per-device strict-IEEE probe `probeStrictIeee` |
| `certified.check.ts` | Node check (fast tier `horizon-cert`) |
| `certified-bench.ts` | Browser side of `scripts/gpu/horizon-cert-bench.mjs` |
| `ridges*.ts`, `scene-profile*.ts`, `opt-in.ts`, `unknown-opt-in.ts`, `bench.ts` | Ridgelines (/roll), the unknown-pose 360° horizon, the app switches, the march bench |

## Certified f32 (precision decision P1, the precision half of WAG W3.1)

The app's skyline has two f64 stages on the CPU after the GPU march (dataflow D7/D8):
- **A (D7)**: `index.ts` collect turns the march's `tBest` (f32) into elevation degrees: `t ≤ −3e38 ? −90 : Math.atan(t) / DEG`, stored as f32. 7200 samples per eye.
- **B + C (D8)**: the horizon-fast-app worker takes each sample (elevation f32, distance f32) back to its geographic point (`destination`), through WGS84 `EnuFrame.fromGeo` to an ENU azimuth / elevation in f64 (B). It then interpolates the profile at the 8192 `GPU_COLUMNS` azimuths and writes unit directions as f32, skipping columns whose bracketing samples hit no terrain (C).

`precision: "certified-f32"` runs these stages on the GPU in f32 arithmetic and certifies each output. The library default stays `"f64"` (the CPU code, unchanged); the app passes `"certified-f32"` by default since 2026-10-01 (3225064, flag `horizonPrecision`, `opt-in.ts`; `?horizonPrecision=f64` restores the CPU stages).

### What "certified" means

The decision unit is one output: an elevation sample in A, and a column in C (its three f32 components and its keep/skip decision). B has no outputs of its own; it feeds C.

For each output the GPU computes a double-f32 value v̂ = hi + lo and a bound e such that

  |v̂ − F| + |ṽ − F| ≤ e,

where F is the exact real value of the f64 path's formula on its inputs and constants, and ṽ is the f64 path's own rounded value just before its `Float32Array` store. The output is certified when every real number within e·(1 + 2⁻¹⁰) of v̂ rounds (to nearest, ties to even) to the same f32 r, and r is normal with 10⁻³⁰ ≤ |r| ≤ 10³⁷. Then `Math.fround(ṽ)` is r: the bits the f64 path stores. A discrete decision (a bracket comparison, `max(Δ, 1e-9)`, keep / skip) is certified when the compared quantity's interval excludes the threshold. A clamp needs no decision, because it is 1-Lipschitz and the bound carries through it.

An output that is not certified goes to the **tie path**: the CPU recomputes it with the f64 code itself (`elevationF64`, `SkylineF64.column`, computing only the samples that column needs). The finished arrays are therefore the f64 path's arrays whenever every certificate is sound. **Certified means: final output bits identical to the f64 path.** Soundness is argued below and checked two ways: the node check (0 false certifications on the emulated machine) and the browser bench (bit identity on the device).

### Arithmetic and how the bound is carried

Let u = 2⁻²⁴, so u² = 2⁻⁴⁸.

**Assumption about the f64 path.** `Math.atan`, `sin`, `cos`, `tan`, `asin`, `atan2` and `hypot` are within 1 ULP of the exact result. ECMAScript leaves their accuracy to the implementation, so this is an **assumption**, not a guarantee. V8 uses fdlibm ports, which are documented below 1 ULP. Every f64-path lump below rests on it.

**f32 assumptions.** These are what the device probe checks:
- add, sub and mul are correctly rounded (WGSL requires this).
- `fma` is fused, i.e. rounded once. WGSL allows it not to be.
- f32 division and sqrt are within 4 ULP. WGSL specifies 2.5 ULP for division, while sqrt inherits the accuracy of 1/inverseSqrt (about 4.5 ULP). A conforming device whose sqrt is worse than 4 ULP fails the probe, which only costs the f64 path.
- There is no re-association. Metal compiles WGSL with fast math, so every intermediate of an error-free transformation goes through `opq()`, an xor with a uniform that is always 0.

**Subnormals.** WGSL lets an implementation flush subnormals, on loads and on results. The stages are built so that flushing never changes a certified answer:
- **No integer or flag bit patterns in `array<f32>`.** A small integer read as f32 is a subnormal and could be flushed to 0. Sample flags are exact floats: 0 for no terrain, 1 for valid, 3 for valid + uncertain, and any other value reads as uncertain. Column start indices are exact small floats.
- **Data inputs are bound as `array<u32>`.** `td` (the march's [t, d]) and `prof` ([elevation, distance]) are classified on their bits: validity (e₀ > −90, d > 0) is decided on the bits, never on a possibly flushed value. A subnormal input goes to the tie path; on a flushing machine it would read as 0, for example t = 10⁻⁴⁰ would certify 0° where the f64 path stores a subnormal.
- **Loads widen the bound.** Every tracked value loaded from an f32 buffer (constants, azimuths, columns, per-sample results) gets 2⁻¹²⁵ added to its bound, the most a flushed hi + lo can move.
- **Results.** A flushed result inside an operation is covered by the absolute 10⁻³⁶ added to every bound.
- **Checked.** The node check runs everything on an emulated machine that flushes on every load and every result: 0 false certifications.

**Double-f32 operations** (Joldes, Muller, Popescu 2017). Each budget is at least the algorithm's proven relative bound:

| op | algorithm | proven | budget |
|---|---|---|---|
| df32 + df32 | AccurateDWPlusDW | 3u² + 13u³ | 3.125u² |
| df32 + f32 | DWPlusFP | 2u² | 3.125u² |
| df32 × df32 | DWTimesDW3 (FMA) | 5u² | 6u² |
| df32 × f32 | DWTimesFP3 (FMA) | 2u² | 6u² |
| df32 / df32 | f32 reciprocal, two residual corrections | 8u² + O(u³), below | 9u² |
| √df32 | f32 sqrt, two Newton corrections | 5.5u² + O(u³), below | 7u² |

- **Division.** Let r ≈ 1/y_h, with a ≤ 4 ULP error, so |r·y − 1| ≤ 9u. Then q₁ = RN(x_h·r) has relative error β ≤ 11u. The first residual correction leaves |q − x/y| ≤ (β² + 2u²)|q| ≤ 123u²|q|. The second correction computes x − y·q with error ≤ 6u²|x| + 3.1u²|rem|, and RN(rem_h·r) misses rem/y by ≤ 11u·123u²|q|. The final DWPlusFP adds 2u². Total ≤ 8u² + 1.4·10³u³.
- **Square root.** Let s₁ = √x_h, with a ≤ 4 ULP error (α ≤ 8.5u), and r = 0.5/s₁. The first Newton step leaves (α²/2 + 10u·α)√x ≤ 121u²√x. The second step leaves ≤ 3u²√x from the residual (DWTimesDW3 plus the subtraction), plus O(u³). The final DWPlusFP adds 2u².

**Tracked values (hi, lo, e).** Each operation propagates e as an absolute bound against the exact operation on exact inputs:
- add: e_x + e_y + ε|z|
- mul: |x|e_y + |y|e_x + e_x·e_y + ε|z|
- div: (e_x + |z|e_y)/(|y| − e_y) + ε|z|. If |y| ≤ e_y the output is uncertain.
- sqrt: e_x/√x + ε|z|

Further terms are added explicitly:
- Series truncation, relative to the argument: sin ≤ 2·10⁻²⁸|r| and 1 − cos ≤ 2·10⁻²⁹r² for |r| ≤ 1/32 (the guard), atan ≤ 10⁻³⁰|z| for |z| ≤ 1/64·(1 + 2⁻¹⁶) (the guard). The atan guard is not 1/64 exactly: k = ⌊32y + 0.5⌋ is computed in f32, and the rounding of 32y + 0.5 can move |y − k/32| past 1/64 by up to 66 ULP of 1/64 (< 2⁻¹⁶ relative). (1/64·(1 + 2⁻¹⁶))¹⁶/17 < 7.5·10⁻³¹.
- Constants: f64-computed values split into df32, with error ≤ (1 + 1/16)u²|v|, and for sin / cos of f64 angles also 2⁻⁵³ absolute.
- f64-path lumps (below).

The bound is evaluated in f32 with rounding to nearest, so it can under-estimate itself by at most (1 − u)^k. A chain of k ≤ 2000 operations is covered by the final factor 1 + 2⁻¹⁰.

**Transcendentals:**
- sin / cos (|x| < 1.6): a table at k/32 (f64 values, df32), with r = x − k/32 exact and |r| ≤ 1/64. Odd / even series to r¹¹ / r¹².
- atan: |x| > 1 goes through π/2 − atan(1/x). Then a table at k/32 with z = (x − c)/(1 + xc), |z| ≤ 1/64·(1 + 2⁻¹⁶), and the odd series to z¹⁵. |x| > 2¹⁰⁰ is refused (uncertain), because WGSL leaves 1/x unspecified for |x| > 2¹²⁶.
- atan2(z, ρ) with ρ > 0 is atan(z/ρ).
- tan θ = sin θ / cos θ.

### Stage A: tan → elevation degrees

- The −90 sentinel (t ≤ the largest f32 ≤ −3e38) and t = ±0 are exact, and decided on t's bits.
- NaN, ±inf, subnormal t and |t| > 2¹⁰⁰ go to the tie path.
- Otherwise the output is atan(t)·(1/DEG) in df32.
- f64 lump: `Math.atan` ≤ 1 ULP and the division rounding, together ≤ 1.5·2⁻⁵²|v|. Budget: 2⁻⁴⁹|v|.
- The total bound is about 20u²|v| ≈ 7·10⁻¹⁴|v|, against an f32 half-ULP ≥ 3·10⁻⁸|v|. Ties are therefore about one in 10⁶, plus the values below 10⁻²⁷° (where the 10⁻³⁶ floor wins) and the inputs above, which always go to the f64 path.

### Stage B: per sample, WGS84 ENU azimuth and elevation

The f64 path forms absolute ECEF coordinates (|x| ≈ 6.4·10⁶ m) for the point and for the frame origin, and subtracts them. Its rounding error is absolute, in metres, and does not shrink with distance. The GPU never forms absolute ECEF. It evaluates the same F through difference formulas that cancel nothing. With s = sin φ, c = cos φ, D = d/R, ds = s₂ − s₁, N = A/√(1 − E²s²):

- ds = c₁ sin D cos a − s₁(1 − cos D)
- s₂ = s₁ + ds
- Y = sin a sin D c₁, X = c₁² − (1 − cos D) − s₁ ds, ρ_λ = √(X² + Y²)
- sin Δλ = Y/ρ_λ, 1 − cos Δλ = Y²/(ρ_λ(ρ_λ + X))
- c₂ = √((1 − s₂)(1 + s₂)), c₂ − c₁ = −ds(s₂ + s₁)/(c₂ + c₁)
- N₂ − N₁ = A E² ds (s₂ + s₁)/(√w₂ √w₁ (√w₁ + √w₂))
- h₂ = eyeH + d(tan e₀ + d·(1 − k)/2R)
- λ cancels in the rotation: east = (N₂ + h₂)c₂ sin Δλ
- P = (N₂ − N₁ + h₂)c₂ + N₁(c₂ − c₁) − (N₂ + h₂)c₂(1 − cos Δλ)
- Z = ((N₂ − N₁)(1 − E²) + h₂)s₂ + N₁(1 − E²)ds
- north = −s₁P + c₁Z, up = c₁P + s₁Z
- z = up + K(e² + n²)/2R − eyeH

The angles:
- **Azimuth.** δ = atan2(e cos a − n sin a, n cos a + e sin a)/DEG. This is (e, n) rotated by the march azimuth: the principal value equal to the f64 unwrap `((b − a) % 360 + 540) % 360 − 180`. |δ| < 45° is required, otherwise the sample is uncertain.
- **Elevation.** atan(z/ρ)/DEG with ρ = √(e² + n²).

**What the f64 path adds (the ENU lump).** This is an absolute bound per ENU component, from `destination()` and the ECEF round trip:
- **ECEF coordinates.** (N + h)·cos φ·cos λ and its siblings carry ≤ 7.5 ULP-equivalents of N + h each: N's sqrt / div, sin / cos at 1 ULP, three products. The point and the origin are independent, and the rotation sums |r_i| ≤ √3. Together ≤ 18·2⁻⁵³·(N + h).
- **Destination latitude.** sin φ₂ is a sum with error ≤ 4.3·2⁻⁵³. asin amplifies it by 1/cos φ₂ and adds 1 ULP, and /DEG then ·DEG add two roundings: ≤ (4.3/cos φ₂ + 2.6)·2⁻⁵³ rad, budgeted as (4.3/cos φ₂ + 3.6)·2⁻⁵³, times N + h. φ₂ is within D of the eye's latitude, and D ≤ 1/32 rad (1.8°: the series guard, which sends anything farther than 199 km to the tie path), so cos φ₂ ≥ cos(|lat| + 1.8°) at any latitude. Certified-f32 refuses |lat| > 85° (f64 everywhere), where 1/cos grows without bound.
- **Destination longitude.** The sum λ₁ + Δλ, then /DEG and ·DEG: ≤ (3|λ| + 0.5)·2⁻⁵³ rad, times N + h.
- **The tan argument.** The f64 path evaluates `Math.tan(e0 * D)`: fl(e₀·DEG) moves θ by ≤ 2⁻⁵³|θ|, so tan moves by (1 + tan²θ)·|θ|·2⁻⁵³, and `Math.tan` adds ≤ 2·2⁻⁵³|tan θ|. Both are multiplied by d into h₂ − eyeH: ≤ 1.25·2⁻⁵³·d·((1 + tan²θ)|θ| + 2|tan θ|), computed per sample from the tracked θ and tan θ.
- **N + h.** The coefficients above multiply N + h. N ≤ A²/b = 6 399 593.6 m is taken as 6.4·10⁶ m in the per-call base. The height part, h ≤ |eyeH| + |h₂ − eyeH| (up to d·tan θ, unbounded for steep rays), is added per sample with the same coefficients, plus 16·2⁻⁵³ for the height arithmetic itself (h₂, the refraction term, z = up − eyeH): (16·2⁻⁵³ + coefficients)·1.25·(|eyeH| + |h₂ − eyeH| + d). That is the uniform's `lumpEnuRel`.
- **Shared roundings.** φ₁ = fl(lat·DEG) and λ₁ = fl(lon·DEG) are the same f64 values in the frame and in `destination()`, and the azimuth angle fl(a·DEG) is used only through its sin / cos. F takes these as inputs, so those roundings cancel.
- **Total.** The sum is multiplied by 1.25. That gives a base of 2.6·10⁻⁸ m at 46.5° N 7.7° E, plus the per-sample height and tan terms.
- **Measured.** max |f64 path − reference| / lump = **0.140** (48 synthetic cases, latitudes −70…75°, any longitude) and **0.130** (19 DEM cases). The reference is the difference formulas in f64, with error ≈ 10⁻¹⁶·d. It shares the f64 path's own `Math.tan(e0·DEG)`, so the tan-argument term is not part of this measurement.

Further lumps:
- **Azimuth.** 10⁻¹²°. This covers atan2, /DEG, the unwrap's operations at magnitudes up to 540° and `at()`'s + 360k (≤ 5·10⁻¹³° together), and the 2⁻⁵³·360° between "360" and 2π/DEG_f64.
- **Elevation.** 2⁻⁴⁹|el|.
- **Measured.** The tracked bounds, lumps included, hold for every sample: max |error| / bound = 0.133 (azimuth) and 0.105 (elevation) on the synthetic and DEM sets.

### Stage C: per column

- **Bracket search.** `at(m) − c = (a_m − c) + 360k + δ_m`, with its bound. Each `while` comparison of the f64 path is replayed with a certified sign, at most 16 steps per direction.
- **Keep / skip.** Exact: sample validity depends only on e₀ > −90 and d > 0, which are inputs.
- **Interpolation.**
  - den = max(Δ, 1e-9), by certified comparison.
  - t = clamp(num/den, 0, 1), with lump 2⁻⁴⁹.
  - e = (e₀ + (e₁ − e₀)t)·DEG, with lump (|e₀| + |e₁|)·DEG·2⁻⁴⁹.
- **Outputs.** sin c·cos e, cos c·cos e and sin e, where sin c and cos c are the f64 path's own `Math.sin(c·D)` / `Math.cos(c·D)` numbers (constants, split into df32). Lump 2⁻⁵⁰|o| for `Math.cos` / `Math.sin` at 1 ULP plus the product rounding.

### The max reduction

The march's tBest is a maximum of f32 values: comparisons only, so the reduction itself is exact in f32 and adds no error. The values it compares come from the march's own f32 arithmetic. That arithmetic matches the CPU twin to about 10⁻⁴° (p99) and was accepted as such on 2026-09-28; it is the input of both precisions. Certification is relative to that march output. Certifying the march against its CPU twin is not in scope: it is not bit-identical today, by design.

### Device probe

`probeStrictIeee(device)` (`src/lib/gpu/precision/ieee-probe.ts`, shared) runs once per device (cached, graph group `precision-probe`), on 4096 deterministic records:
- wide exponents (±60), magnitudes up to 2²⁴, cancellations, tiny addends, subnormal operands and results;
- add / mul / fma, TwoSum, FastTwoSum and TwoProd bit for bit against the emulation. Where a record touches subnormals, the flush-to-zero result is accepted too;
- division and sqrt within 4 ULP;
- df32 add / mul / div / sqrt within their budgets against f64.

Any failure, or a GPU error, makes `precision: "certified-f32"` run the f64 path everywhere (`stats.fellBack`). The node check `ieee-probe.check.ts` shows the verifier has teeth: it rejects a machine whose TwoSum is re-associated away, one whose fma rounds twice, and one whose division is off by 8 ULP. It accepts a flushing machine. The probe tests samples. It is not a proof about the device's arithmetic.

**The per-shader gap.** The probe validates its own shader module. Whether `fma` is fused, whether subnormals flush, and how fast math re-associates are decided by the compiler per shader, so a pass does not prove that the horizon kernels compile the same way. Two things close the gap:
- `opq()` in every error-free transformation.
- **A per-call spot check.** After each GPU run, `spotCheckA` / `spotCheckC` (`certified.ts`) re-derive random GPU-certified outputs on the CPU emulation and compare all bits and flags. For stage C, the samples a column needs are emulated on demand. On this device the GPU's certificates equal the emulation's bit for bit on every output (bench), so a mismatch means the shader is not computing what was proven: the whole call then runs the f64 path (`stats.fellBack: "spot check: …"`), and the stage is disabled for that adapter (below). The node check confirms that the emulation's own outputs pass and that corrupted certified outputs are caught, with 64 and with 8 samples.
- **How many outputs a call checks** (`../precision/spot-policy.ts`, since 2026-10-01): a ledger keyed by (stage, hash of the stage's WGSL, adapter identity and device features). The first 3 calls per key re-derive 64 outputs (the full check, what every call did before); after that every call re-derives 8, and 1 call in 32 at random runs the full check again (the photoprep pattern). A mismatch disables the key for the rest of the page. The horizon stages run in a fresh worker per photo, so the page keeps the ledger: it posts it with the worker's `spans` message and merges the worker's copy back from each result (`stats.precision.spotLedger`). A fresh `GPUDevice` on the same adapter compiles the same WGSL with the same features to the same pipeline, which is what the key encodes.

A wrong certificate that no spot check samples could still slip through when it is rare, with 64 samples as with 8. The spot check guards against systematic compilation differences, the ones that would affect many outputs of every call that runs a pipeline: those are caught by the qualifying full checks, and 8 samples per later call still catch any difference that touches more than about a quarter of the certified outputs with probability ≥ 0.9. It is not a per-output proof, and the per-output certificate does not depend on it.

### Results

**Node check** (`npx tsx src/lib/gpu/horizon/certified.check.ts --many --all-real`, 19 s; the fast tier runs the default size, about 5 s):

| set | outputs | false certifications | finished ≠ f64 | tie path |
|---|---|---|---|---|
| stage A, random t (all magnitudes, sentinels, ±0, subnormals, \|t\| > 2¹⁰⁰) | 400 000 | 0 | 0 | 2.3 % (the special values: subnormal t, \|t\| > 2¹⁰⁰, \|v\| < 10⁻²⁷) |
| stage A, DEM (19 ground-truth eyes) | 136 800 | 0 | 0 | 0 % |
| stages B + C, synthetic (48 cases, with rare subnormal inputs) | 393 216 columns | 0 | 0 of 48 | 4.9 % |
| stages B + C, synthetic, division / sqrt ±3 ULP | 131 072 columns | 0 | 0 of 16 | 3.0 % |
| stage A + stages B + C, flush-to-zero machine (loads and results) | 400 000 samples, 147 456 columns | 0 | 0 | 2.3 % / 3.3 % |
| stages B + C, DEM (19 ground-truth eyes) | 155 648 columns | 0 | 0 of 19 | 45.0 % (see below) |

Teeth: when a 10⁻⁹ relative error that the bound does not cover is injected, the check sees 4563 (A) and 525 (B + C) false certifications.

**Where the ties come from.** On the DEM set, per photo:
- 0.4–6.4 % where the skyline is ≥ ~1 km away: IMG_3304, 4527, 6326, 6971, 7018, 7033, 7108, 7130, 7131.
- 21–29 % where part of the skyline is within tens of metres: IMG_4703, 5495.
- 80–100 % for the 8 eyes that sit at or below the coarse LITE DEM surface, where the whole skyline is at the 2 m minimum distance at 70–83° elevation: IMG_6019, 6958, 7053, 7059, 7063, 7068, 7086, 7155.

At d = 2 m the f64 path's own ECEF rounding (≈ 10⁻⁸ m) is 5·10⁻⁹ rad of angle, more than an f32 output ULP, so no f32 method can certify those columns. They are the f64 path's numerical noise, not GPU error. Elsewhere most ties are sin e for small elevations, where the f32 ULP is small. The bound is about 8× the measured error. Two terms dominate it: the f64-path lump (worst case about 10× its observed value) and the df32 error of terms like N₁(c₂ − c₁), which grows with d.

**Browser bench** (`scripts/gpu/horizon-cert-bench.mjs`, 2026-10-01, Apple GPU, headless Chromium WebGPU, the 19 ground-truth eyes, GPU march; after the review fixes):
- **Probe:** passed.
- **Bit identity:** 0 differing bits in elevation, distance and directions on every photo.
- **Spot check:** passed on every call. Stage A checks 64 samples; C checks 64 columns, or all certified columns when fewer than 64 are certified (5–32 on the degenerate eyes).
- **GPU vs emulation:** the GPU's certificates match the CPU emulation's exactly on every output (no output certified by one side only, no bit difference where both certify).
- **Tie path:** stage A ≤ 1 sample of 7200. Stages B + C: 0.4–6.0 % on distant skylines; 21.5 / 28.9 % for IMG_4703 / 5495; 80–99.9 % for the 8 eyes at the 2 m minimum distance.
- **Timing (warm medians):**
  - The certified stage A adds ~0.5–1 ms to a 1–8 ms march (GPU run 0.3–0.7 ms plus the 64-sample spot check), in place of the CPU atan loop.
  - Stages B + C take 4.0–8.7 ms certified (GPU 1.2–1.7 ms plus finish 2.6–7.0 ms) against 2.0–2.2 ms for f64. The finish is dominated by the stage-C spot check: the CPU emulation re-derives 64 columns and about 170 samples in tracked double-f32 arithmetic, about 5–6 ms in JS.
  - Certified-f32 is therefore slower than f64 for this stage in the worker today. Its value is the GPU-resident path the page-device horizon needs. A cheaper emulation (no per-operation tuple allocation) or fewer stage-C spot checks would cut the finish.
  - Spot-check ledger (2026-10-01): node timing of the spot check on a 7200-sample profile, packed buffers reused: stage C 1.75 ms with 64 columns, 0.27 ms with 8; stage A 0.10 / 0.07 ms (the scan for certified indices dominates). After the 3 qualifying calls per adapter, a call pays the 8-sample check, and 1 in 32 calls the 64-sample one. The browser finish was not re-measured.
  - All figures include the uploads (td / prof 57.6 KB, az 230 KB, cols 256 KB) and readbacks.

### Wiring and the default

- `computeHorizonGpu(device, mosaics, eyes, { …, precision: "certified-f32" })` gives elevations through stage A. The march output is read back as before and uploaded to the stage-A graph.
- `skylineDirs(device, prof, job, eyeH, precision)` gives the worker's directions.
- The horizon-fast-app worker uses both when the `horizonPrecision` flag is `certified-f32` (`src/lib/flags`, the default) and the GPU march is on (`horizonPrecisionOptIn()`). Its `stats.precision` reports ties and timings.
- The flag default is `certified-f32` since 2026-10-01 (3225064): the precision gate (50 dev photos, deck and webgpu, plus GT-12) found no quality difference, though the f64 baseline itself was not reproducible run to run, so decisions were judged on quality rather than bit identity. `?horizonPrecision=f64` keeps the CPU stages.
- The gate: `node scripts/gpu/precision-gate.mjs [--stage horizon|align|both] [--eval]` runs the frozen dev split through the wild harness's app method twice (f64 vs certified-f32, `--renderer webgpu` pinned, one render-lock step per chunk of photos) and requires identical decisions, poses and per-seed results, and that the certified path really ran. The render worker takes the flags from `MATCHER_RENDERER` / `MATCHER_HORIZON_PRECISION` / `MATCHER_ALIGN_PRECISION`; `scripts/eval-app.mjs` takes `--horizon-precision` / `--align-precision` / `--json`. Each records the path the stages took (`lastFastHorizonStats` in `horizon-fast-app.ts`, `lastAlignTiming` in `../align`).
- The kernels read plain storage buffers (`td` = the march's [t, d] pairs, `prof` = [elevation, distance]). The page-device horizon (W3.1's device half) can then bind the march's output transient directly and fuse A → B → C into one graph. B needs A's exact elevations, so the fused graph would propagate A's uncertainty into B, marking a sample uncertain when A is. Today A finishes on the CPU before B runs.

## GPU march vs CPU march: benign differences

The WGSL march (`horizon.wgsl.ts`) is not a line-for-line copy of `marchRay`; two details differ on purpose and neither changes the skyline beyond the f32 tolerance:

- **Skip floor.** After a mip skip the CPU advances `d = skipTo > d + 1e-3 ? skipTo : d + 1e-3`. In f32, `d + 1e-3 == d` beyond about 16 km, so the WGSL uses `minNext = max(dt + 1e-3, dt · (1 + 2.4e-7))` (at least one ULP-ish) and then resets the Kahan compensation (`dc = 0`).
- **Loop test.** The WGSL `while (d < dB)` tests the uncompensated Kahan sum `d`, while the sample distance, the skip bounds and `tBest` use the compensated `dt = d - dc`. The CPU tests and samples the same f64 `d`. The two differ by less than the compensation term (a few f32 ULP of `d`), so a segment can end at most one step earlier or later.
