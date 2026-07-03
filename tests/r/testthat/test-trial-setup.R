test_that("prep_plot derives defaults in imperial units", {
  pi <- prep_plot("seed", "imperial", machine_width = 60, section_num = 24, harvester_width = 30)
  expect_equal(pi$input_name, "seed")
  expect_equal(pi$unit_system, "imperial")
  # widths are stored in meters internally
  expect_equal(pi$machine_width, 60 * 0.3048)
  expect_equal(pi$section_width, 60 * 0.3048 / 24)
  expect_equal(pi$harvester_width, 30 * 0.3048)
  # default plot width derived from machine/harvester widths (here 30 ft)
  expect_equal(pi$plot_width, 30 * 0.3048)
  expect_true(pi$headland_length > 0)
  expect_true(pi$min_plot_length > 0)
  expect_true(pi$max_plot_length >= pi$min_plot_length)
})

test_that("prep_plot accepts metric units without conversion", {
  pi <- prep_plot("seed", "metric", machine_width = 18, section_num = 24, harvester_width = 9)
  expect_equal(pi$machine_width, 18)
  expect_equal(pi$harvester_width, 9)
  expect_equal(pi$unit_system, "metric")
})

test_that("prep_plot honors explicit plot_width and lengths", {
  pi <- prep_plot("seed", "imperial", machine_width = 60, section_num = 24,
                  harvester_width = 30, plot_width = 30,
                  headland_length = 90, side_length = 60,
                  min_plot_length = 200, max_plot_length = 300)
  expect_equal(pi$plot_width, 30 * 0.3048)
  expect_equal(pi$headland_length, 90 * 0.3048)
  expect_equal(pi$side_length, 60 * 0.3048)
})

test_that("prep_plot covers the machine-width default ladder", {
  # headland default depends on machine width thresholds (120/240/300 ft)
  small <- prep_plot("seed", "imperial", machine_width = 20, section_num = 1, harvester_width = 20)
  large <- prep_plot("seed", "imperial", machine_width = 120, section_num = 1, harvester_width = 120)
  expect_true(large$headland_length >= small$headland_length)
})

test_that("prep_rate with explicit rates freezes them", {
  ri <- prep_rate(seed_plot_info(), gc_rate = 34000, unit = "seeds",
                  rates = c(20000, 26000, 32000, 38000, 44000))
  expect_equal(ri$rates_data[[1]]$rate, c(20000, 26000, 32000, 38000, 44000))
  expect_equal(ri$gc_rate, 34000)
  expect_equal(ri$unit, "seeds")
  # design_type stays NA in the rate info; the ls default applies at assignment
  expect_true(is.na(ri$design_type))
})

test_that("prep_rate derives rates from min/max/num anchored on gc_rate", {
  ri <- prep_rate(nh3_plot_info(), gc_rate = 180, unit = "lb",
                  min_rate = 100, max_rate = 260, num_rates = 4)
  rates <- ri$rates_data[[1]]$rate
  expect_length(rates, 4)
  expect_equal(min(rates), 100)
  expect_equal(max(rates), 260)
})

test_that("prep_rate accepts every ported design type", {
  # ls/str/rstr/rb keep the given order with sequential ranks
  for (dt in c("ls", "str", "rstr", "rb")) {
    ri <- seed_rate_info(design_type = dt)
    expect_equal(ri$design_type, dt)
    expect_equal(ri$rates_data[[1]]$rate, seed_rates)
    expect_equal(ri$rates_data[[1]]$rate_rank, 1:5)
  }
  # sparse moves gc_rate to the front (rank 1)
  ri_sp <- prep_rate(seed_plot_info(), gc_rate = 32000, unit = "seeds",
                     rates = seed_rates, design_type = "sparse")
  expect_equal(ri_sp$rates_data[[1]]$rate[1], 32000)
  expect_equal(ri_sp$rates_data[[1]]$rate_rank, 1:5)
  expect_setequal(ri_sp$rates_data[[1]]$rate, seed_rates)
  # ejca requires an even number of rates, sequential ranks
  ri <- prep_rate(seed_plot_info(), gc_rate = 34000, unit = "seeds",
                  rates = c(20000, 26000, 38000, 44000), design_type = "ejca")
  expect_equal(ri$design_type, "ejca")
  expect_equal(ri$rates_data[[1]]$rate, c(20000, 26000, 38000, 44000))
  expect_equal(ri$rates_data[[1]]$rate_rank, 1:4)
})

test_that("prep_rate carries rank sequences and rate jump threshold", {
  ri <- prep_rate(seed_plot_info(), gc_rate = 34000, unit = "seeds",
                  rates = seed_rates, design_type = "ls",
                  rank_seq_ws = c(1, 3, 5, 2, 4), rank_seq_as = c(2, 4, 1, 3, 5),
                  rate_jump_threshold = 2)
  expect_equal(ri$rank_seq_ws[[1]], c(1, 3, 5, 2, 4))
  expect_equal(ri$rank_seq_as[[1]], c(2, 4, 1, 3, 5))
  expect_equal(ri$rate_jump_threshold, 2)
})

test_that("conv_unit converts table pairs and convert_rates maps doses", {
  expect_equal(ofpetrial:::conv_unit(150, "feet", "meters"), 45.72)
  expect_equal(ofpetrial:::convert_rates("NH3", "gallons", 10), 42)
  expect_equal(ofpetrial:::convert_rates("urea", "lb", 100), 46)
  expect_equal(ofpetrial:::convert_rates("NH3", "gallons", 42, "from_n_equiv"), 10)
  # unknown input name passes through unchanged
  expect_equal(ofpetrial:::convert_rates("seed", "seeds", 34000), 34000)
})
