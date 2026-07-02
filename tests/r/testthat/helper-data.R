# Shared, lazily-built objects for the ported-scope test suite.
# Heavy steps (make_exp_plots) run once and are memoized across test files.

ed <- system.file("extdata", package = "ofpetrial")

boundary_simple <- sf::st_read(file.path(ed, "boundary-simple1.shp"), quiet = TRUE)
abline_simple <- sf::st_read(file.path(ed, "ab-line-simple1.shp"), quiet = TRUE)
boundary_holes <- sf::st_read(file.path(ed, "field_boundary_with_holes.shp"), quiet = TRUE)
abline_holes <- sf::st_read(file.path(ed, "ab_line_for_field_with_holes.shp"), quiet = TRUE)
ssurgo_sf <- sf::st_read(file.path(ed, "ssurgo-simple1.shp"), quiet = TRUE)
ec_sf <- sf::st_read(file.path(ed, "ec-simple1.shp"), quiet = TRUE)

.cache <- new.env(parent = emptyenv())

memo <- function(key, expr) {
  if (!exists(key, envir = .cache)) assign(key, force(expr), envir = .cache)
  get(key, envir = .cache)
}

seed_plot_info <- function(unit_system = "imperial") {
  if (unit_system == "imperial") {
    prep_plot("seed", "imperial", machine_width = 60, section_num = 24, harvester_width = 30)
  } else {
    prep_plot("seed", "metric", machine_width = 18, section_num = 24, harvester_width = 9)
  }
}

nh3_plot_info <- function() {
  prep_plot("NH3", "imperial", machine_width = 30, section_num = 1, harvester_width = 30)
}

seed_rates <- c(20000, 26000, 32000, 38000, 44000)

seed_rate_info <- function(design_type = NA, ...) {
  prep_rate(seed_plot_info(), gc_rate = 34000, unit = "seeds", rates = seed_rates,
            design_type = design_type, ...)
}

exp_simple <- function() {
  memo("exp_simple", make_exp_plots(seed_plot_info(), boundary_simple, abline_simple))
}

exp_two_input <- function() {
  memo("exp_two_input",
       make_exp_plots(list(seed_plot_info(), nh3_plot_info()), boundary_simple, abline_simple))
}

td_simple <- function() {
  memo("td_simple", {
    set.seed(20260702)
    assign_rates(exp_simple(), seed_rate_info())
  })
}

td_two_input <- function() {
  memo("td_two_input", {
    set.seed(20260702)
    assign_rates(
      exp_two_input(),
      list(
        seed_rate_info(),
        prep_rate(nh3_plot_info(), gc_rate = 180, unit = "lb",
                  min_rate = 100, max_rate = 260, num_rates = 4)
      )
    )
  })
}
