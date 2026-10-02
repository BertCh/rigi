# Unit tests (Vitest)

Rigi has two kinds of automated test, both run by the regression gate (`scripts/ci/run.mjs`):

| kind | files | runner | use it for |
|---|---|---|---|
| **unit specs** | `*.spec.ts` (node), `*.spec.tsx` (happy-dom) | Vitest (`vitest.config.ts`) | per-function behaviour: invariants, round trips, edge cases, small synthetic recoveries, React components |
| **check scripts** | `*.check.ts`, older `*.test.ts`, `*.check.mjs` | `npx tsx <file>`, one row each in `scripts/ci/checks.mjs` | exhaustive sweeps, bit-identity of CPU twins against GPU emulations, real-data gates, anything that prints a report |

```sh
npm test                                   # every spec, once (~seconds)
npm run test:watch                         # watch mode while developing
npx vitest run src/lib/geo                 # one directory
npx vitest run --project dom               # only the React / DOM specs
npm run test:coverage                      # v8 coverage → out/coverage/index.html
node scripts/ci/run.mjs fast --only unit   # the same suite as a gate row
```

## Writing a spec

- Put it in a `__tests__/` directory next to the module: `src/lib/geo/__tests__/sun.spec.ts`.
  A spec that checks two modules against each other across a boundary lint (for example the
  Gipfelbuch adapter against the ontology tables) goes in `src/test/cross/`.
  Name it `.spec.tsx` if it renders React or needs `document` / `window`.
- Start the file with the Rigi SPDX header (`node scripts/ci/spdx.mjs` checks it).
- Import from `"vitest"` explicitly (globals are off). `#/…` and `@/…` resolve to `src/`.
- Specs are pure CPU and deterministic: no GPU device, no browser, no network (stub `fetch` with
  `vi.stubGlobal`), no gitignored data (`data/`, `public/photos/`, `.cache/`). That is why the
  `unit` row never SKIPs, and why it belongs to the fast tier.
- Use `seededRandom` from `src/test/helpers.ts` for property-style loops, never `Math.random`.
- Test behaviour, not the implementation: inverse pairs round-trip, solvers recover a synthetic
  answer, bad input falls back. A spec that only restates the code is not worth its upkeep.
- GPU code is tested on its CPU side (pure helpers, the CPU twins, layouts, fake devices as in the
  existing `*.check.ts` files). Real-device and pixel checks stay in the batched full tier.
- A bug found while writing a spec and not fixed in the same change is pinned with
  `it.fails(…)` and a `// BUG:` comment. Fixing the bug turns the spec red until `.fails` is removed.

## Helpers

- `src/test/setup.ts`: runs before every spec file; clears `globalThis.__RIGI_FLAGS__` after each test.
  Mocks, stubbed globals and env are restored automatically (`restoreMocks`, `unstubGlobals`, `unstubEnvs`).
- `src/test/helpers.ts`: `seededRandom`, `uniform`, `expectArrayClose`, `angleDiffDeg`, `withFlags`.
- `src/test/dom.ts`: a `@tanstack/react-router` mock (`routerMock`, settable `routerState.searchStr`,
  `navigateSpy`) for components that read the route.

Gotcha: happy-dom reports `navigator.webdriver === true`, which the app treats as "running under a
harness" (reveal animations off, sections open). Stub it to `false` when a spec needs the user path.

## Coverage and the registry

- `npm run test:coverage` measures `src/lib/**` and `src/brand/**`. The thresholds in
  `vitest.config.ts` are a ratchet: raise them as coverage grows, never lower them to pass.
- `scripts/ci/__tests__/checks.spec.ts` tests the gate itself: ids unique, scripts exist, browser
  rows under the render lock with a pinned engine, and every tracked check script registered (or
  listed in its `UNREGISTERED` table with the reason). Adding a `*.check.ts` without a registry row
  fails `npm test`.
