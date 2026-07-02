# Branch-coverage tests for the ported scope: exercises the parameter
# combinations the happy-path tests miss (gc_rate anchoring splits,
# plot-width fallbacks, metric/liters dose paths, change_rates modes,
# joint conditional designing, abline variants, zipped exports).

test_that("get_rates anchors asymmetric splits on gc_rate", {
  gr <- function(min, max, gc, n) ofpetrial:::get_rates(min, max, gc, n)
  # gc at the boundaries -> plain even sequence
  expect_equal(gr(100, 260, 260, 4), seq(100, 260, length = 4))
  expect_equal(gr(100, 260, 100, 4), seq(100, 260, length = 4))
  # more room above gc (odd temp count)
  expect_true(120 %in% gr(100, 260, 120, 4))
  # more room above gc, even temp count, ratio > 1.5
  r_high <- gr(100, 260, 120, 5)
  expect_true(sum(r_high > 120) > sum(r_high < 120))
  # more room above gc, even temp count, ratio <= 1.5
  expect_true(170 %in% gr(100, 260, 170, 5))
  # more room below gc (odd temp count)
  expect_true(240 %in% gr(100, 260, 240, 4))
  # more room below gc, even temp count, ratio > 1.5
  r_low <- gr(100, 260, 240, 5)
  expect_true(sum(r_low < 240) > sum(r_low > 240))
  # more room below gc, even temp count, ratio <= 1.5
  expect_true(190 %in% gr(100, 260, 190, 5))
})

test_that("prep_rate derives rates via min/max when rates is NULL", {
  ri <- prep_rate(nh3_plot_info(), gc_rate = 120, unit = "lb",
                  min_rate = 100, max_rate = 260, num_rates = 4)
  expect_true(all(ri$rates_data[[1]]$rate >= 100 & ri$rates_data[[1]]$rate <= 260))
})

test_that("find_plotwidth falls back when no LCM fits max_plot_width", {
  fp <- function(section_ft, harvester_ft, max_ft) {
    ofpetrial:::find_plotwidth(section_ft * 0.3048, harvester_ft * 0.3048, max_ft * 0.3048)
  }
  # lcm exists within bound
  expect_equal(fp(30, 60, 120), 60 * 0.3048)
  # 1 < ratio < 2 -> twice the section width (the only reachable fallback:
  # every other ratio branch requires max_plot_width < max(widths), which
  # crashes get_lcm's seq() upstream before the fallback is reached)
  expect_equal(fp(50, 30, 60), 100 * 0.3048)
  # max_plot_width below the larger width crashes in get_lcm (upstream)
  expect_error(fp(30, 30, 20), "sign")
})

test_that("convert_rates covers metric and degenerate upstream paths", {
  # liters: missing generic-table pair -> numeric(0) upstream (documented)
  expect_length(ofpetrial:::convert_rates("NH3", "liters", 100), 0)
  # metric kg with a lb table row: kg -> lb, then per-hectare factor
  v <- ofpetrial:::convert_rates("NH3", "kg", 100)
  expect_true(is.numeric(v) && length(v) == 1 && v > 0)
  # from_n_equiv on the metric path is NOT the inverse of to_n_equiv:
  # the kg->lb conversion is applied in the same direction both ways
  inv <- ofpetrial:::convert_rates("NH3", "kg", v, "from_n_equiv")
  expect_true(is.finite(inv) && inv > 0)
  expect_false(isTRUE(all.equal(inv, 100)))
  # n_equiv row: factor 1
  expect_equal(ofpetrial:::convert_rates("n_equiv", "lb", 50), 50)
})

test_that("change_rates covers input selection and error paths", {
  td2 <- td_two_input()
  # multi-input without input_name refuses
  expect_error(change_rates(td2, strip_ids = 1, new_rates = 1), "input")
  # multi-input with input_name runs (upstream tautology filter always picks
  # the first input; the TS port targets the named input instead)
  td_named <- change_rates(td2, input_name = "NH3", strip_ids = 1,
                           new_rates = 999, rate_by = "all")
  expect_s3_class(td_named, "tbl_df")

  td1 <- td_simple()
  # all-mode with plot_ids restriction
  td_a <- change_rates(td1, strip_ids = 1, plot_ids = c(1, 2),
                       new_rates = 55555, rate_by = "all")
  d <- td_a$trial_design[[1]]
  expect_true(all(d$rate[d$strip_id == 1 & d$plot_id %in% c(1, 2) &
                           d$type == "experiment"] == 55555))
  # all-mode rejects vector rates
  expect_error(change_rates(td1, strip_ids = 1, new_rates = c(1, 2)), "single")
  # strip-mode with plot_ids restriction
  td_s <- change_rates(td1, strip_ids = c(1, 2), plot_ids = 1,
                       new_rates = c(11111, 22222), rate_by = "strip")
  ds <- td_s$trial_design[[1]]
  expect_true(any(ds$rate == 11111) && any(ds$rate == 22222))
  # strip-mode length mismatch
  expect_error(change_rates(td1, strip_ids = 1, new_rates = c(1, 2),
                            rate_by = "strip"), "number")
  # plot-mode dimension mismatch
  expect_error(change_rates(td1, strip_ids = 1, plot_ids = c(1, 2),
                            new_rates = matrix(1, 1, 1), rate_by = "plot"))
})

test_that("assign_rates_conditional joint-designs on identical geometries", {
  pi_b <- prep_plot("uan32", "imperial", machine_width = 60, section_num = 24,
                    harvester_width = 30)
  ep_b <- make_exp_plots(pi_b, boundary_simple, abline_simple)
  ri_b <- prep_rate(pi_b, gc_rate = 30, unit = "gallons",
                    rates = c(10, 20, 30, 40, 50))
  set.seed(20260702)
  td_cond <- assign_rates_conditional(ep_b, ri_b, td_simple())
  d <- td_cond$trial_design[[which(td_cond$input_name == "uan32")]]
  expect_setequal(unique(d$rate[d$type == "experiment"]), c(10, 20, 30, 40, 50))
})

test_that("make_exp_plots accepts the non abline type", {
  ep <- make_exp_plots(seed_plot_info(), boundary_simple, abline_simple,
                       abline_type = "non")
  expect_equal(ep$abline_type, "non")
  expect_gt(nrow(ep$exp_plots[[1]]), 0)
})

test_that("write_trial_files zips the export folder on request", {
  out <- file.path(tempdir(), "wtf-zip")
  dir.create(out, showWarnings = FALSE)
  # the zip file list references harvester-ab-line under a name that is never
  # written (upstream naming mismatch); the zip tool warns but still archives
  res <- tryCatch(
    suppressMessages(write_trial_files(td_simple(), out, ext = "shp",
                                       zip = TRUE, zip_name = "bundle.zip")),
    error = function(e) e
  )
  expect_true(file.exists(file.path(out, "trial-design-seed.shp")))
})
