# Upstream version-bump procedure

When a new ofpetrial version lands on CRAN:

1. **Work list** — `bun run tools/upstream-sync.ts <current> <new>` diffs the
   R sources restricted to the ported scope (`tools/r-coverage-scope.json`)
   and maps each touched function to its TS symbol via `parity-map.json`.
2. **Port the changes** — update each listed TS symbol to the new R
   semantics; record any new deviation in `parity-map.json`.
3. **Regenerate references** — update the pinned version in
   `tools/gen-fixtures.R` comments, `tools/r-coverage.R` (`OFP_VERSION`),
   `parity-map.json`, and `src/index.ts` (`OFPETRIAL_R_VERSION`); then:
   - `Rscript tools/gen-fixtures.R` (golden masters)
   - `Rscript tools/run-test-cases.R --update` if shared expected values moved
4. **Re-run both suites**
   - R: `Rscript tools/run-test-cases.R` and `Rscript tools/r-coverage.R`
     (>= 95% gate; new upstream functions belong in the scope file's
     `include`, or in `exclude` with a reason)
   - TS: `bun run typecheck && bun run lint && bun run test`
5. **Ship** — commit fixtures + code together, tag; the publish workflow
   re-checks `tools/check-parity-map.ts` on the tag build.
