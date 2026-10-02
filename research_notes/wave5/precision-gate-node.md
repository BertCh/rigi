# Node certified-stage gate (precision-gate-node)

`scripts/gpu/precision-gate-node.ts`: the certified-f32 precision gate without a browser, on a Dawn
WebGPU device in node. It reuses the browser gate's scoring (`scripts/gpu/precision-gate-score.mjs`:
`scorePhoto`, `decide`, blind-verified verdicts), so its verdict and exit codes mean the same thing.
Built in wave 5 (C3), browser-unverified; only a 2-photo tooling smoke was run (not the gate).

## Usage

    # once: mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0
    DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/precision-gate-node.ts \
        [--stage both|horizon|align] [--ids a,b | --limit N] [--seeds full|lite] \
        [--out out/gpu/precision-gate-node]

Batch-pass command (full dev split, all harness seeds, both stages):

    DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/precision-gate-node.ts --stage both --seeds full

Smoke (tooling unit test only): `--limit 2 --seeds lite`.
Output: `out/gpu/precision-gate-node/{results.json,summary.json,summary.md}`. Exit 0 PASS, 1 FAIL,
3 INCONCLUSIVE, 4 NEEDS-VERIFY, 2 usage / no GPU. Node only, no render lock needed.

## Design

Frozen dev split only (`tools/bench/split.json` "dev"; `--ids` outside it is refused; the test half and
`data_v3` are never read), joined to the wild manifest. Per photo one scene (terrain, mosaics, CPU edge
map) and three modes in order: base (f64/f64), cand (certified-f32 for the chosen stage(s)), base2 (f64
again, the run-to-run noise floor). Per mode: GPU horizon march with `precision`, `skylineDirs` to ENU
directions, then every harness seed (yaw x pitch x focal) through `autoAlignAsync` with `alignPrecision`,
and the harness wrapper's decision (`decideApp` + `acceptRule` ported from `tools/bench/harness/run.ts`).

Compared: accept/reject sets (base vs cand vs base2), false accepts against the blind verdicts, lost
verified-correct accepts, decided-pose deltas and the worst per-seed pose delta, bit identity, horizon
direction hashes, and whether the certified paths really ran (a cand that fell back everywhere is
INCONCLUSIVE).

## Differences from the browser gate (so a PASS here is evidence, not the gate)

- No rendered silhouette re-rank: total = autoAlign score, `sil` null.
- No foreground mask; edge map is the CPU `edgeMapFromPixels` of a @napi-rs/canvas 512 px decode.
- Full 360 degree horizon even for photos with a heading (the browser uses the wedge).
- Condition "given" only; the GT-12 eval arm is not run.
- Node runs are deterministic, so base vs base2 will usually be identical (noise floor 0); the browser
  gate's noise came from page effects (blank first draw, terrain timeouts) absent here.
