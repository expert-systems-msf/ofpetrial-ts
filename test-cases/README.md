# Shared test cases

Runtime-neutral parity cases consumed by both runners:

- TypeScript: `tests/test-cases.test.ts` (vitest, auto-discovers `*.json` here)
- R: `Rscript tools/run-test-cases.R` (testthat, same discovery, validates the
  `expected` values against ofpetrial 0.1.3; `--update` regenerates them)

## File format

```json
{
  "suite": "units",
  "cases": [
    {
      "name": "human-readable case name",
      "function": "convUnit",
      "input": { "named": "arguments" },
      "expected": 45.72,
      "tolerance": 1e-6,
      "rParity": true
    }
  ]
}
```

- `function`: symbol in each runner's registry (TS camelCase; the R runner
  maps it to the ofpetrial equivalent).
- `input`: named arguments, applied by the registry adapter.
- `expected`: number, array, or object compared with relative closeness
  `|actual - expected| <= tolerance * max(1, |expected|)` element-wise.
- `rParity`: when `false`, the case covers a documented TS deviation from
  R 0.1.3 (see `parity-map.json` notes) — the R runner skips it.
