#!/usr/bin/env Rscript
# Cross-validation reference for task 6.4: the range of check_ortho_with_chars
# correlations that R's own assign_rates produces on the simple1/imperial
# layout across 10 seeds. The TS 6.4 test asserts its assignRates designs land
# inside this envelope (+/- a small margin), i.e. "metrics within the range of
# the N reference R designs".
#
# Correlations are computed with the same fragment/cor method as
# tools/gen-fixtures.R (st_intersection of the full trial design, headlands
# included, then unweighted cor(use = "complete.obs")) — byte-for-byte the
# operation check_ortho_with_chars/summarize_indiv_char performs.
#
# Deterministic: set.seed(s) immediately before each assign_rates call.
# Run from the repo root:  Rscript tools/gen-crossval-fixture.R

suppressPackageStartupMessages({
  library(ofpetrial)
  library(sf)
  library(dplyr)
  library(jsonlite)
})

ED <- system.file("extdata", package = "ofpetrial")
SEEDS <- 1:10

boundary <- st_read(file.path(ED, "boundary-simple1.shp"), quiet = TRUE)
abline <- st_read(file.path(ED, "ab-line-simple1.shp"), quiet = TRUE)
ssurgo <- st_read(file.path(ED, "ssurgo-simple1.shp"), quiet = TRUE)
soil_vars <- names(ssurgo)[vapply(st_drop_geometry(ssurgo), is.numeric, logical(1))]

# simple1/imperial parameters — identical to tools/gen-fixtures.R seed_input()
plot_info <- prep_plot(
  input_name = "seed", unit_system = "imperial",
  machine_width = 60, section_num = 24, harvester_width = 30
)
rate_info <- prep_rate(
  plot_info,
  gc_rate = 34000, unit = "seeds",
  rates = c(20000, 26000, 32000, 38000, 44000)
)
exp_data <- make_exp_plots(plot_info, boundary, abline)

char_sf <- dplyr::select(ssurgo, dplyr::all_of(soil_vars))

per_seed <- lapply(SEEDS, function(s) {
  set.seed(s)
  td <- assign_rates(exp_data, rate_info)
  design <- dplyr::select(td$trial_design[[1]], rate)
  suppressWarnings(frags <- sf::st_intersection(design, char_sf))
  frag_df <- sf::st_drop_geometry(frags)
  vapply(
    soil_vars,
    function(v) stats::cor(cbind(frag_df$rate, frag_df[[v]]), use = "complete.obs")[1, 2],
    numeric(1)
  )
})

per_var <- lapply(soil_vars, function(v) {
  vals <- vapply(per_seed, function(x) x[[v]], numeric(1))
  list(min = min(vals), max = max(vals))
})
names(per_var) <- soil_vars

json <- jsonlite::toJSON(
  list(
    ofpetrialVersion = as.character(utils::packageVersion("ofpetrial")),
    case = "simple1/imperial",
    input = "seed",
    seeds = SEEDS,
    perVar = per_var
  ),
  digits = NA, auto_unbox = TRUE, pretty = TRUE
)
writeLines(json, "fixtures/crossval-reference.json")

message("Cross-validation reference written to fixtures/crossval-reference.json")
