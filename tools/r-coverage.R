#!/usr/bin/env Rscript
# R coverage gate for the ported scope (>= 95%).
#
# Downloads the ofpetrial 0.1.3 CRAN source (cached under tools/.cache/),
# injects the repo's testthat suite (tests/r/), runs covr::package_coverage,
# and computes line coverage restricted to the ported perimeter defined in
# tools/r-coverage-scope.json. Fails (exit 1) below the threshold. The full
# per-function report is archived at coverage/r-coverage.json.
#
# Run from the repo root:  Rscript tools/r-coverage.R

suppressPackageStartupMessages({
  library(covr)
  library(jsonlite)
})

THRESHOLD <- 0.95
OFP_VERSION <- "0.1.3"
CACHE <- file.path("tools", ".cache")
SRC <- file.path(CACHE, paste0("ofpetrial-", OFP_VERSION))

scope <- jsonlite::fromJSON("tools/r-coverage-scope.json", simplifyVector = FALSE)
include <- unlist(scope$include)
exclude <- names(scope$exclude)

# --- fetch + prepare the package source --------------------------------------

if (!dir.exists(SRC)) {
  dir.create(CACHE, recursive = TRUE, showWarnings = FALSE)
  tarball <- file.path(CACHE, paste0("ofpetrial_", OFP_VERSION, ".tar.gz"))
  if (!file.exists(tarball)) {
    download.file(
      paste0("https://cloud.r-project.org/src/contrib/ofpetrial_", OFP_VERSION, ".tar.gz"),
      tarball, mode = "wb", quiet = TRUE
    )
  }
  untar(tarball, exdir = CACHE)
  file.rename(file.path(CACHE, "ofpetrial"), SRC)
}

# Refresh the test suite inside the source tree on every run.
unlink(file.path(SRC, "tests"), recursive = TRUE)
dir.create(file.path(SRC, "tests", "testthat"), recursive = TRUE, showWarnings = FALSE)
file.copy("tests/r/testthat.R", file.path(SRC, "tests", "testthat.R"), overwrite = TRUE)
for (f in list.files("tests/r/testthat", full.names = TRUE)) {
  file.copy(f, file.path(SRC, "tests", "testthat", basename(f)), overwrite = TRUE)
}

# --- run coverage -------------------------------------------------------------

message("Running covr::package_coverage (instrumented install + test suite)...")
cov <- covr::package_coverage(SRC, type = "tests", quiet = TRUE)

tally <- covr::tally_coverage(cov, by = "line")
# tally: one row per (filename, functions, line, value)
tally$covered <- tally$value > 0

per_function <- aggregate(
  cbind(total = rep(1, nrow(tally)), covered = tally$covered),
  by = list(fn = tally$functions),
  FUN = sum
)
per_function$pct <- per_function$covered / per_function$total

sanity_unknown <- setdiff(per_function$fn, c(include, exclude))
if (length(sanity_unknown)) {
  message("Namespace functions absent from the scope file (counted as excluded): ",
          paste(sanity_unknown, collapse = ", "))
}

in_scope <- per_function[per_function$fn %in% include, ]
missing_from_tally <- setdiff(include, per_function$fn)
if (length(missing_from_tally)) {
  message("Scope functions with no coverage data (0 lines executed?): ",
          paste(missing_from_tally, collapse = ", "))
}

scope_total <- sum(in_scope$total)
scope_covered <- sum(in_scope$covered)
scope_pct <- scope_covered / scope_total

# --- report -------------------------------------------------------------------

dir.create("coverage", showWarnings = FALSE)
report <- list(
  ofpetrialVersion = OFP_VERSION,
  threshold = THRESHOLD,
  scopeCoverage = scope_pct,
  scopeLines = scope_total,
  scopeCoveredLines = scope_covered,
  functions = lapply(seq_len(nrow(in_scope)), function(i) {
    list(
      name = in_scope$fn[i],
      lines = in_scope$total[i],
      covered = in_scope$covered[i],
      pct = in_scope$pct[i]
    )
  }),
  missingFromTally = as.list(missing_from_tally)
)
writeLines(
  jsonlite::toJSON(report, digits = 6, auto_unbox = TRUE, pretty = TRUE),
  "coverage/r-coverage.json"
)

# Uncovered-line dump for targeted test writing.
uncovered <- tally[!tally$covered & tally$functions %in% include, c("filename", "functions", "line")]
uncovered <- uncovered[order(uncovered$functions, uncovered$line), ]
write.csv(uncovered, "coverage/r-uncovered.csv", row.names = FALSE)

worst <- in_scope[order(in_scope$pct), ][seq_len(min(12, nrow(in_scope))), ]
message(sprintf("Ported-scope coverage: %.2f%% (%d/%d lines)",
                100 * scope_pct, scope_covered, scope_total))
message("Lowest-covered scope functions:")
for (i in seq_len(nrow(worst))) {
  message(sprintf("  %-38s %6.1f%% (%d/%d)",
                  worst$fn[i], 100 * worst$pct[i], worst$covered[i], worst$total[i]))
}

if (scope_pct < THRESHOLD) {
  stop(sprintf("Coverage %.2f%% below the %.0f%% threshold.", 100 * scope_pct, 100 * THRESHOLD))
}
message("COVERAGE OK")
