# src/lib/gpu/precision: shared pieces for certified-f32 stages

Precision decision P1 (certified f32) has a GPU stage compute in f32 arithmetic and carry an exact error bound. The stage certifies an output only when every value within the bound rounds to the same f32. The CPU recomputes the uncertain outputs with the f64 code, so the final output is bit-identical to the f64 path. This directory holds what every such stage needs.

| File | What it gives you |
|---|---|
| `df32.ts` | The **f32 machine emulation** for node checks: `fr` (`Math.fround`), `fma32` (exact single-rounding FMA), `div32` / `sqrt32` (correctly rounded, or perturbed by ±k ULP with `setDivSqrtPerturbation` for stress tests), `setFlushSubnormals` (flush-to-zero mode), `bits32` / `fromBits32` / `nextUp32` / `nextDown32`. Also **double-f32 arithmetic**: `twoSum`, `fastTwoSum`, `twoProd`, `ddAdd`, `ddAddF`, `ddMul`, `ddMulF`, `ddDiv`, `ddSqrt`, `split`, with per-operation budgets `EPS_ADD` 3.125u², `EPS_MUL` 6u², `EPS_DIV` 9u², `EPS_SQRT` 7u² (u = 2⁻²⁴), and **`DF32_WGSL`**, the same functions in WGSL |
| `ieee-probe.ts` | **`probeStrictIeee(device)`**, the per-device strict-IEEE probe (cached, never rejects; graph group `precision-probe`), plus its pure parts `probeInputs`, `emuProbe`, `verifyProbe` |
| `ieee-probe.check.ts` | Fast-tier check `ieee-probe`: the df32 budgets on 200 000 random pairs, and the verifier's accept / reject behaviour (it accepts a flushing machine and rejects broken ones) |

Using it in a new stage (the horizon stages in `../horizon/certified*.ts` are the worked example):
1. Write the stage's WGSL on `DF32_WGSL`. The kernel needs a uniform `u32` that is always 0 and sets `ZERO = u.zero;` first thing. `opq()` blocks fast-math re-association of the error-free transformations.
2. Mirror the stage in TypeScript on `df32.ts`, carrying a bound per value. The horizon's tracked `(hi, lo, e)` rules are in `../horizon/certified-cpu.ts`. Add the f64 path's own rounding ("lumps") explicitly, and prove the certificate in a node check with 0 false certifications and fault-injection teeth.
3. On the device, `await probeStrictIeee(device)`. If `!ok`, run the f64 path everywhere.
4. **Spot-check every call.** The probe validates only its own shader module; fma fusion, subnormal flushing and fast-math re-association are decided per compiled shader. Re-derive a random sample of the GPU-certified outputs (the horizon uses 64) on the emulation after each run, and run the f64 path for the whole call on any mismatch. The horizon's `spotCheckA` / `spotCheckC` in `../horizon/certified.ts` are the pattern.
5. **Subnormals.** WGSL may flush them, on load and on results:
   - never store flags or integers as bit patterns in `array<f32>` (use exact floats or a u32 buffer);
   - bind exact data inputs as `array<u32>` and decide on their bits;
   - widen every tracked value loaded from an f32 buffer by 2⁻¹²⁵.

   `setFlushSubnormals(true)` turns the emulation into a flushing machine for the node check.

The probe checks samples. It cannot prove that a device's arithmetic is correct everywhere: a pass is evidence, not a proof. What it assumes and checks is listed in `ieee-probe.ts`. The derivations of the `ddDiv` / `ddSqrt` budgets are in `../horizon/README.md` ("Arithmetic").
