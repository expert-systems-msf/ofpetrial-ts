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
  library(terra)
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

# Factor/character summary: summarize_indiv_char's character branch, over the
# SAME st_intersection fragments as the numeric vars (compute_fragments is
# generic in `vars` and works unmodified for a character column) — unweighted
# mean(rate)/sd(rate) grouped by class, first-appearance order (data.table's
# default `by=`, no sort).
compute_factor_summary <- function(fragments, var) {
  dt <- data.table::as.data.table(fragments)
  out <- dt[, .(rateMean = mean(rate), rateSd = stats::sd(rate)), by = var]
  data.frame(class = out[[var]], rateMean = out$rateMean, rateSd = out$rateSd)
}

# Raster branch: check_ortho_with_chars' SpatRaster path (summarize_chars) —
# terra::extract(raster, rate_design, fun = mean, na.rm = TRUE) over the FULL
# trial design (plots + headlands), one row per design polygon (per-plot
# mean, not per-fragment — see diagnose.R and diagnostics.ts's
# extractRasterMeans docstring for why this differs from the vector path).
compute_raster_plot_means <- function(trial_design, rast, var) {
  design <- dplyr::select(trial_design, rate, strip_id, plot_id, type)
  ext <- terra::extract(rast, dplyr::select(design, rate), fun = mean, na.rm = TRUE)
  design_df <- sf::st_drop_geometry(design)
  plot_key <- ifelse(
    design_df$type == "headland",
    "headland",
    paste0(design_df$strip_id, ":", design_df$plot_id)
  )
  data.frame(plotKey = plot_key, rate = design_df$rate, mean = ext[[var]])
}

# Reference correlation for the raster branch: unweighted cor(use =
# "complete.obs") between rate and the per-plot raster mean.
compute_raster_correlation <- function(means, var) {
  list(var = var, corWithRate = stats::cor(means$rate, means$mean, use = "complete.obs"))
}

# Sanity gate: ofpetrial:::summarize_chars (the ACTUAL internal the exported
# factor summary claims to replicate, ggplot figures and all) must reproduce
# the written per-class table exactly — same classes in the same order, same
# rate_mean/rate_sd.
verify_factor_summary <- function(trial_design, soil_sf, written) {
  ref <- ofpetrial:::summarize_chars(trial_design, soil_sf, "musym")$summary_data[[1]]
  stopifnot(nrow(ref) == nrow(written))
  stopifnot(identical(as.character(ref$musym), as.character(written$class)))
  for (pair in list(c("rate_mean", "rateMean"), c("rate_sd", "rateSd"))) {
    r <- ref[[pair[[1]]]]
    w <- written[[pair[[2]]]]
    stopifnot(identical(is.na(r), is.na(w)))
    ok <- is.na(r) | abs(r - w) <= 1e-9 * pmax(1, abs(r))
    stopifnot(all(ok))
  }
}

# Sanity gate: ofpetrial:::summarize_chars' SpatRaster branch must reproduce
# the written raster correlation, and recomputing the correlation from the
# written per-plot means must agree too — tying the means table to the same
# terra::extract output that produced the correlation.
verify_raster_fixtures <- function(trial_design, rast, means, written_cor) {
  ref_cor <- ofpetrial:::summarize_chars(trial_design, rast, "slope")$summary_data[[1]]$cor_with_rate
  tol <- 1e-9 * max(1, abs(ref_cor))
  stopifnot(abs(written_cor$corWithRate - ref_cor) <= tol)
  cor_from_means <- stats::cor(means$rate, means$mean, use = "complete.obs")
  stopifnot(abs(cor_from_means - ref_cor) <= tol)
}

# Alignment fragments: check_alignment's interior up to (but excluding) its
# data.table aggregation — one row per harvester-strip x experiment-plot
# intersection fragment (ha_area = harvester strip area clipped to the field).
# The TS precomputed mode replays only the aggregation, so checkAlignment can
# be parity-tested at 1e-6, free of turf-vs-GEOS / proj4-vs-PROJ geometry noise.
compute_alignment_fragments <- function(td) {
  td %>%
    dplyr::select(input_name, exp_plots, harvester_width, harvest_ab_lines, field_sf) %>%
    dplyr::rowwise() %>%
    dplyr::mutate(exp_plots = list(ofpetrial:::make_sf_utm(exp_plots))) %>%
    dplyr::mutate(harvest_ab_lines = list(ofpetrial:::make_sf_utm(harvest_ab_lines))) %>%
    dplyr::mutate(field_sf = list(ofpetrial:::make_sf_utm(field_sf))) %>%
    tidyr::unnest(harvest_ab_lines) %>%
    dplyr::rename(harvest_ab_line = x) %>%
    dplyr::rowwise() %>%
    dplyr::mutate(fragments = list(
      ofpetrial:::make_harvest_path(harvester_width, harvest_ab_line, field_sf) %>%
        dplyr::mutate(ha_area = as.numeric(sf::st_area(geometry))) %>%
        ofpetrial:::st_intersection_quietly(ofpetrial:::st_transform_utm(exp_plots)) %>%
        .$result %>%
        dplyr::mutate(area = as.numeric(sf::st_area(geometry))) %>%
        sf::st_drop_geometry() %>%
        dplyr::select(ha_strip_id, strip_id, area, ha_area) %>%
        # st_intersection leaves non-default row names ("3", "3.1", ...) that
        # jsonlite would serialize as a spurious _row column
        tibble::remove_rownames()
    )) %>%
    dplyr::ungroup()
}

# Sanity gate: replaying check_alignment's aggregation on the exported
# fragments must reproduce its overlap_data exactly (they are the same rows).
verify_alignment_fragments <- function(frags, expected_overlap) {
  agg <- data.table::as.data.table(frags)
  agg <- agg[, .(area = sum(area), ha_area = mean(ha_area)), by = .(ha_strip_id, strip_id)]
  agg <- agg[!is.na(strip_id), ]
  agg[, total_intersecting_ha_area := sum(area), by = ha_strip_id]
  agg[, intersecting_pct := total_intersecting_ha_area / ha_area]
  agg <- agg[intersecting_pct > 0.1, ]
  agg <- agg[, .SD[which.max(area), ], by = ha_strip_id]
  agg[, dominant_pct := area / total_intersecting_ha_area]
  agg <- agg[order(ha_strip_id), ]
  exp_df <- as.data.frame(expected_overlap)
  agg_df <- as.data.frame(agg)
  stopifnot(nrow(agg_df) == nrow(exp_df))
  for (col in names(exp_df)) {
    scale <- max(1, max(abs(exp_df[[col]])))
    stopifnot(max(abs(agg_df[[col]] - exp_df[[col]])) <= 1e-9 * scale)
  }
}

# Ortho-inputs fragments: check_ortho_inputs' interior up to (but excluding)
# cov.wt — one row per experiment-plot x experiment-plot intersection fragment
# of the two inputs' trial designs, with the pair of rates and the fragment
# area (the cov.wt weight). Two-input cases only.
compute_ortho_fragments <- function(td) {
  td_1 <- dplyr::filter(td$trial_design[[1]], type == "experiment")
  td_2 <- dplyr::filter(td$trial_design[[2]], type == "experiment")
  suppressWarnings(
    inter <- sf::st_intersection(td_1, td_2) %>%
      sf::st_make_valid() %>%
      dplyr::mutate(area = as.numeric(sf::st_area(geometry))) %>%
      dplyr::select(rate, rate.1, area) %>%
      sf::st_drop_geometry()
  )
  data.frame(rate_1 = inter$rate, rate_2 = inter$rate.1, area = inter$area)
}

# Sanity gate: cov.wt over the exported fragments must reproduce the
# check_ortho_inputs correlation exactly.
verify_ortho_fragments <- function(frags, expected_cor) {
  cor_check <- stats::cov.wt(
    data.frame(rate = frags$rate_1, rate.1 = frags$rate_2),
    wt = frags$area, cor = TRUE
  )$cor[1, 2]
  stopifnot(abs(cor_check - expected_cor) <= 1e-9 * max(1, abs(expected_cor)))
}

run_case <- function(case_name, unit_system, inputs, boundary, abline, soil_sf, soil_vars, slope_rast) {
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

    # -- raster + factor fixtures (additive, simple1 only: the soil layer and
    # slope.tif both only cover that field's extent) --
    if (case_name == "simple1") {
      factor_fragments <- compute_fragments(td$trial_design[[i]], soil_sf, "musym")
      write_json_file(factor_fragments, file.path(in_dir, "factor-fragments.json"))
      factor_summary <- compute_factor_summary(factor_fragments, "musym")
      verify_factor_summary(td$trial_design[[i]], soil_sf, factor_summary)
      write_json_file(factor_summary, file.path(in_dir, "factor-summary.json"))

      raster_means <- compute_raster_plot_means(td$trial_design[[i]], slope_rast, "slope")
      raster_cor <- compute_raster_correlation(raster_means, "slope")
      verify_raster_fixtures(td$trial_design[[i]], slope_rast, raster_means, raster_cor)
      write_json_file(raster_means, file.path(in_dir, "raster-plot-means.json"))
      write_json_file(raster_cor, file.path(in_dir, "raster-correlations.json"))
    }
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

  # -- precomputed fragment tables for the TS 1e-6 diagnostics parity mode --
  align_frag_rows <- compute_alignment_fragments(td)
  for (i in seq_len(nrow(align_frag_rows))) {
    in_dir <- file.path(case_dir, align_frag_rows$input_name[[i]])
    frags <- align_frag_rows$fragments[[i]]
    verify_alignment_fragments(frags, alignment$overlap_data[[i]])
    write_json_file(frags, file.path(in_dir, "alignment-fragments.json"))
  }
  if (nrow(td) > 1) {
    ortho_frags <- compute_ortho_fragments(td)
    verify_ortho_fragments(ortho_frags, ortho_inputs)
    write_json_file(ortho_frags, file.path(case_dir, "ortho-fragments.json"))
  }

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

# Raster soil layer for the SpatRaster branch of check_ortho_with_chars
# (simple1 only — its extent matches the simple1 field, same as ssurgo above).
slope_rast <- terra::rast(file.path(ED, "slope.tif"))

unlink(OUT, recursive = TRUE)
dir.create(OUT, showWarnings = FALSE)

# The shared soil layer, reprojected to WGS84 for the TS spatial-join tests.
write_geojson(st_transform(ssurgo, 4326), file.path(OUT, "ssurgo-simple1.geojson"))
# Versioned copy of the raster asset so TS tests can read it directly.
file.copy(file.path(ED, "slope.tif"), file.path(OUT, "slope.tif"), overwrite = TRUE)

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
    run_case(cd$name, us, inputs, cd$boundary, cd$abline, ssurgo, soil_vars, slope_rast)
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
