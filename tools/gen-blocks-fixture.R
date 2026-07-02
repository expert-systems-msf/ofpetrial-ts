#!/usr/bin/env Rscript
# Golden-master fixture for addBlocks parity (task 5.4): replays the simple1
# imperial fixture pipeline (same SEED as tools/gen-fixtures.R), applies
# add_blocks(), and exports block_id/plot_id_within_block per (strip_id,
# plot_id) as JSON for tests/parity-rate-assignment.test.ts to compare
# against the TS addBlocks() run on the frozen trial-design.geojson fixture.
#
# Run from the repo root: Rscript tools/gen-blocks-fixture.R

suppressPackageStartupMessages({
  library(ofpetrial)
  library(sf)
  library(dplyr)
  library(jsonlite)
  library(data.table)
})

SEED <- 20260702
ED <- system.file("extdata", package = "ofpetrial")

set.seed(SEED)

boundary_simple <- st_read(file.path(ED, "boundary-simple1.shp"), quiet = TRUE)
abline_simple <- st_read(file.path(ED, "ab-line-simple1.shp"), quiet = TRUE)

plot_info <- prep_plot(
  input_name = "seed", unit_system = "imperial",
  machine_width = 60, section_num = 24, harvester_width = 30
)
rate_info <- prep_rate(
  plot_info = plot_info, gc_rate = 34000, unit = "seeds",
  rates = c(20000, 26000, 32000, 38000, 44000)
)

exp_data <- make_exp_plots(plot_info, boundary_simple, abline_simple)

set.seed(SEED)
td <- assign_rates(exp_data, rate_info)
td_blocks <- add_blocks(td)

trial_design <- td_blocks$trial_design[[1]]
out <- st_drop_geometry(trial_design) %>%
  dplyr::select(strip_id, plot_id, type, block_id, plot_id_within_block) %>%
  dplyr::mutate(
    strip_id = ifelse(is.na(strip_id), NA, strip_id),
    plot_id = ifelse(is.na(plot_id), NA, plot_id)
  )

json <- jsonlite::toJSON(out, digits = NA, na = "null", pretty = TRUE)
writeLines(json, "fixtures/simple1/imperial/seed/blocks.json")
message("Wrote fixtures/simple1/imperial/seed/blocks.json (", nrow(out), " rows)")
