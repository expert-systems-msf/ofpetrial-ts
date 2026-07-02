#!/usr/bin/env Rscript
# Golden-master fixture generator for ofpetrial-ts.
#
# Replays the ofpetrial 0.1.3 pipeline (prep_plot -> prep_rate ->
# make_exp_plots -> assign_rates -> checks -> write_trial_files) on three
# geometric cases x two unit systems and freezes every step under fixtures/.
# Deterministic: fixed seed, no timestamps in any JSON output.
#
# Run from the repo root:  Rscript tools/gen-fixtures.R
#
# Known non-determinism boundaries: shapefile .dbf headers embed the
# last-update date, so r-exports/ are only byte-identical across runs made
# the same day; manifest.json embeds rVersion/ofpetrialVersion, which differ
# across environments. All other JSON/GeoJSON outputs are fully deterministic.

suppressPackageStartupMessages({
  library(ofpetrial)
  library(sf)
  library(dplyr)
  library(jsonlite)
  library(data.table)
})

SEED <- 20260702
OUT <- "fixtures"
ED <- system.file("extdata", package = "ofpetrial")

set.seed(SEED)

# --- helpers ---------------------------------------------------------------

write_json_file <- function(x, path) {
  json <- jsonlite::toJSON(
    x,
    digits = NA, auto_unbox = TRUE, force = TRUE,
    null = "null", na = "null", pretty = TRUE
  )
  writeLines(json, path)
}

write_geojson <- function(sf_obj, path) {
  if (file.exists(path)) unlink(path)
  sf::st_write(
    sf_obj, path,
    driver = "GeoJSON", quiet = TRUE,
    layer_options = c("COORDINATE_PRECISION=9", "RFC7946=YES")
  )
}

# Drop sf/list-heavy columns a tibble row carries so it JSON-serializes cleanly.
scalar_columns <- function(tb) {
  keep <- vapply(tb, function(col) {
    if (is.list(col)) {
      !inherits(col[[1]], c("sf", "sfc", "gg", "ggplot"))
    } else {
      TRUE
    }
  }, logical(1))
  as.data.frame(tb[, keep, drop = FALSE])
}

# Fragments table: st_intersection of the FULL trial design (experiment plots
# AND headlands, headlands carrying rate = gc_rate) with the soil layer —
# byte-for-byte the same operation check_ortho_with_chars/summarize_chars
# performs (st_intersection on the rate column), with plot identifiers kept so
# the TS side can key fragments as "strip:plot" / "headland".
compute_fragments <- function(trial_design, soil_sf, vars) {
  design <- dplyr::select(trial_design, rate, strip_id, plot_id, type)
  char_sf <- dplyr::select(soil_sf, dplyr::all_of(vars))
  suppressWarnings(frags <- sf::st_intersection(design, char_sf))
  frag_df <- sf::st_drop_geometry(frags)
  plot_key <- ifelse(
    frag_df$type == "headland",
    "headland",
    paste0(frag_df$strip_id, ":", frag_df$plot_id)
  )
  out <- data.frame(plotKey = plot_key, rate = frag_df$rate)
  for (v in vars) out[[v]] <- frag_df[[v]]
  out
}

# Reference correlations: unweighted cor(use = "complete.obs") between rate
# and each numeric soil variable over the fragments — summarize_indiv_char.
compute_correlations <- function(fragments, vars) {
  cors <- lapply(vars, function(v) {
    m <- stats::cor(cbind(fragments$rate, fragments[[v]]), use = "complete.obs")
    list(var = v, corWithRate = m[1, 2])
  })
  cors
}

run_case <- function(case_name, unit_system, inputs, boundary, abline, soil_sf, soil_vars) {
  case_dir <- file.path(OUT, case_name, unit_system)
  dir.create(case_dir, recursive = TRUE, showWarnings = FALSE)

  plot_infos <- lapply(inputs, function(inp) {
    do.call(prep_plot, c(list(input_name = inp$input_name, unit_system = unit_system), inp$plot_args))
  })
  rate_infos <- mapply(function(pi, inp) {
    do.call(prep_rate, c(list(plot_info = pi), inp$rate_args))
  }, plot_infos, inputs, SIMPLIFY = FALSE)

  exp_data <- if (length(plot_infos) == 1) {
    make_exp_plots(plot_infos[[1]], boundary, abline)
  } else {
    make_exp_plots(plot_infos, boundary, abline)
  }

  set.seed(SEED) # per-case determinism, independent of execution order
  td <- if (length(rate_infos) == 1) {
    assign_rates(exp_data, rate_infos[[1]])
  } else {
    assign_rates(exp_data, rate_infos)
  }

  # -- per-step JSON --
  write_json_file(lapply(plot_infos, scalar_columns), file.path(case_dir, "plot-info.json"))
  write_json_file(rate_infos, file.path(case_dir, "rate-info.json"))
  write_json_file(
    lapply(inputs, function(inp) c(list(input_name = inp$input_name), inp$plot_args, inp$rate_args)),
    file.path(case_dir, "params.json")
  )

  # -- per-input GeoJSON + fragments/correlations --
  # The soil layer only covers the simple1 field; cases on other boundaries
  # produce no fragments and get empty files.
  for (i in seq_len(nrow(td))) {
    input_name <- td$input_name[[i]]
    in_dir <- file.path(case_dir, input_name)
    dir.create(in_dir, showWarnings = FALSE)
    write_geojson(td$exp_plots[[i]], file.path(in_dir, "plots.geojson"))
    write_geojson(td$headland[[i]], file.path(in_dir, "headlands.geojson"))
    write_geojson(td$ab_lines[[i]], file.path(in_dir, "ab-line.geojson"))
    write_geojson(td$harvest_ab_lines[[i]], file.path(in_dir, "harvester-ab-line.geojson"))
    write_geojson(td$trial_design[[i]], file.path(in_dir, "trial-design.geojson"))

    stopifnot("headland" %in% td$trial_design[[i]]$type) # full design incl. headlands
    fragments <- compute_fragments(td$trial_design[[i]], soil_sf, soil_vars)
    write_json_file(fragments, file.path(in_dir, "fragments.json"))
    correlations <- if (nrow(fragments) > 0) compute_correlations(fragments, soil_vars) else list()
    write_json_file(correlations, file.path(in_dir, "correlations.json"))
  }

  # -- checks --
  alignment <- check_alignment(td)
  ortho_inputs <- if (nrow(td) > 1) suppressMessages(check_ortho_inputs(td)) else NULL
  checks <- list(
    alignment = lapply(seq_len(nrow(alignment)), function(i) {
      list(
        inputName = alignment$input_name[[i]],
        overlapData = as.data.frame(alignment$overlap_data[[i]])
      )
    }),
    orthoInputs = ortho_inputs
  )
  write_json_file(checks, file.path(case_dir, "checks.json"))

  # -- R machine exports (unzipped: zip archives embed timestamps) --
  export_dir <- file.path(case_dir, "r-exports")
  dir.create(export_dir, showWarnings = FALSE)
  suppressWarnings(write_trial_files(td, export_dir, ext = "shp", zip = FALSE))

  invisible(td)
}

# --- shared inputs ----------------------------------------------------------

boundary_simple <- st_read(file.path(ED, "boundary-simple1.shp"), quiet = TRUE)
abline_simple <- st_read(file.path(ED, "ab-line-simple1.shp"), quiet = TRUE)
# Pathological contour: field boundary with interior holes — the case that
# stresses the TS clipping/repair path (tasks 4.3/4.3b exit criterion).
boundary_holes <- st_read(file.path(ED, "field_boundary_with_holes.shp"), quiet = TRUE)
abline_holes <- st_read(file.path(ED, "ab_line_for_field_with_holes.shp"), quiet = TRUE)

ssurgo <- st_read(file.path(ED, "ssurgo-simple1.shp"), quiet = TRUE)
soil_vars <- names(ssurgo)[vapply(st_drop_geometry(ssurgo), is.numeric, logical(1))]

unlink(OUT, recursive = TRUE)
dir.create(OUT, showWarnings = FALSE)

# The shared soil layer, reprojected to WGS84 for the TS spatial-join tests.
write_geojson(st_transform(ssurgo, 4326), file.path(OUT, "ssurgo-simple1.geojson"))

# --- case definitions --------------------------------------------------------
# plot_args/rate_args are unit-system-specific; imperial mirrors the package
# vignette, metric uses round metric machine dimensions and kg/liters doses.

seed_input <- function(us) {
  if (us == "imperial") {
    list(
      input_name = "seed",
      plot_args = list(machine_width = 60, section_num = 24, harvester_width = 30),
      rate_args = list(gc_rate = 34000, unit = "seeds", rates = c(20000, 26000, 32000, 38000, 44000))
    )
  } else {
    list(
      input_name = "seed",
      plot_args = list(machine_width = 18, section_num = 24, harvester_width = 9),
      rate_args = list(gc_rate = 34000, unit = "seeds", rates = c(20000, 26000, 32000, 38000, 44000))
    )
  }
}

nh3_input <- function(us) {
  if (us == "imperial") {
    list(
      input_name = "NH3",
      plot_args = list(machine_width = 30, section_num = 1, harvester_width = 30),
      rate_args = list(gc_rate = 180, unit = "lb", min_rate = 100, max_rate = 260, num_rates = 4)
    )
  } else {
    list(
      input_name = "NH3",
      plot_args = list(machine_width = 9, section_num = 1, harvester_width = 9),
      rate_args = list(gc_rate = 200, unit = "kg", min_rate = 110, max_rate = 290, num_rates = 4)
    )
  }
}

# Single source of truth for the case list — drives both generation and the
# manifest, so they cannot drift apart.
case_defs <- list(
  list(
    name = "simple1", boundary = boundary_simple, abline = abline_simple,
    input_factories = list(seed_input)
  ),
  list(
    name = "two-input", boundary = boundary_simple, abline = abline_simple,
    input_factories = list(seed_input, nh3_input)
  ),
  list(
    name = "with-holes", boundary = boundary_holes, abline = abline_holes,
    input_factories = list(seed_input)
  )
)
unit_systems <- c("imperial", "metric")

for (us in unit_systems) {
  for (cd in case_defs) {
    message(sprintf("== case %s / %s ==", cd$name, us))
    inputs <- lapply(cd$input_factories, function(f) f(us))
    run_case(cd$name, us, inputs, cd$boundary, cd$abline, ssurgo, soil_vars)
  }
}

# --- manifest ----------------------------------------------------------------

write_json_file(
  list(
    ofpetrialVersion = as.character(utils::packageVersion("ofpetrial")),
    rVersion = paste(R.version$major, R.version$minor, sep = "."),
    seed = SEED,
    generatedCases = lapply(case_defs, function(cd) {
      list(
        name = cd$name,
        inputs = lapply(cd$input_factories, function(f) f("imperial")$input_name)
      )
    }),
    unitSystems = as.list(unit_systems)
  ),
  file.path(OUT, "manifest.json")
)

message("Fixture generation complete.")
