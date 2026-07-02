# Second wave of branch-coverage tests: rank-sequence fallbacks, design-type
# messages, file-path inputs, differing plot widths, conditional third-input
# designing, and remaining validation errors.

test_that("prep_plot validates argument dimensions", {
  expect_error(prep_plot(c("a", "b"), "imperial", 60, 24, 30), "Inconsistent")
})

test_that("prep_plot warns about explicit plot widths with mixed treatment", {
  # a smaller conflict-free plot width exists
  expect_message(
    prep_plot("seed", "imperial", machine_width = 30, section_num = 1,
              harvester_width = 30, plot_width = 60)
  )
  # specified width causes mixed treatment, an alternative exists
  expect_message(
    prep_plot("seed", "imperial", machine_width = 60, section_num = 1,
              harvester_width = 60, plot_width = 50)
  )
  # no conflict-free width exists at all
  expect_message(
    prep_plot("seed", "imperial", machine_width = 50, section_num = 1,
              harvester_width = 30, max_plot_width = 60, plot_width = 90)
  )
})

test_that("prep_rate guides the user when no rate specification is given", {
  # emits a guidance message, then fails downstream (rates never defined)
  expect_message(
    try(prep_rate(seed_plot_info(), gc_rate = 34000, unit = "seeds",
                  num_rates = NULL),
        silent = TRUE),
    "provide either"
  )
})

test_that("prep_rate rejects odd ejca rate counts and unknown designs", {
  expect_error(
    prep_rate(seed_plot_info(), gc_rate = 34000, unit = "seeds",
              rates = c(1, 2, 3), design_type = "ejca"),
    "odd"
  )
  expect_error(
    prep_rate(seed_plot_info(), gc_rate = 34000, unit = "seeds",
              rates = c(1, 2, 3), design_type = "jcls"),
    "design_type"
  )
})

test_that("rank helpers cover the large-count and small-count shortcuts", {
  expect_setequal(sort(unique(ofpetrial:::gen_basic_rank_ws(9, NA))), 1:9)
  expect_setequal(sort(unique(ofpetrial:::gen_basic_rank_ws(10, NA))), 1:10)
  set.seed(20260702)
  expect_setequal(ofpetrial:::get_starting_rank_as_ls(1:3), 1:3)
  expect_setequal(ofpetrial:::get_starting_rank_as_ls(1:9), 1:9)
})

test_that("assign_rates covers rank-sequence fallbacks and design messages", {
  ep <- exp_simple()
  # ls with only rank_seq_as -> ws generated, message emitted
  ri_as <- prep_rate(seed_plot_info(), gc_rate = 34000, unit = "seeds",
                     rates = seed_rates, design_type = "ls",
                     rank_seq_as = c(2, 4, 1, 3, 5))
  set.seed(20260702)
  expect_message(assign_rates(ep, ri_as), "rank_seq_as")
  # rb ignores rank sequences with a message
  ri_rb <- prep_rate(seed_plot_info(), gc_rate = 34000, unit = "seeds",
                     rates = seed_rates, design_type = "rb",
                     rank_seq_ws = c(1, 3, 5, 2, 4), rank_seq_as = c(1, 2, 3, 4, 5))
  set.seed(20260702)
  expect_message(assign_rates(ep, ri_rb), "ignored")
  # str with rank_seq_as provided
  ri_str <- prep_rate(seed_plot_info(), gc_rate = 34000, unit = "seeds",
                      rates = seed_rates, design_type = "str",
                      rank_seq_as = c(2, 4, 1, 3, 5))
  set.seed(20260702)
  td_str <- assign_rates(ep, ri_str)
  expect_gt(nrow(td_str$trial_design[[1]]), 0)
  # rstr warns that rank_seq_ws is irrelevant
  ri_rstr <- prep_rate(seed_plot_info(), gc_rate = 34000, unit = "seeds",
                       rates = seed_rates, design_type = "rstr",
                       rank_seq_ws = c(1, 3, 5, 2, 4))
  set.seed(20260702)
  expect_message(assign_rates(ep, ri_rstr), "irrelevant")
})

test_that("assign_rates messages when rank_seq blocks joint designing", {
  pi_a <- prep_plot("seed", "imperial", machine_width = 60, section_num = 24,
                    harvester_width = 30)
  pi_b <- prep_plot("uan32", "imperial", machine_width = 60, section_num = 24,
                    harvester_width = 30)
  ep <- make_exp_plots(list(pi_a, pi_b), boundary_simple, abline_simple)
  ri_a <- prep_rate(pi_a, gc_rate = 34000, unit = "seeds", rates = seed_rates,
                    rank_seq_ws = c(1, 3, 5, 2, 4))
  ri_b <- prep_rate(pi_b, gc_rate = 30, unit = "gallons",
                    rates = c(10, 20, 30, 40, 50))
  set.seed(20260702)
  expect_message(assign_rates(ep, list(ri_a, ri_b)), "independently")
})

test_that("make_exp_plots handles two inputs with different plot widths", {
  pi_a <- prep_plot("seed", "imperial", machine_width = 60, section_num = 24,
                    harvester_width = 30)
  pi_b <- prep_plot("NH3", "imperial", machine_width = 40, section_num = 1,
                    harvester_width = 30)
  expect_true(pi_a$plot_width != pi_b$plot_width)
  ep <- make_exp_plots(list(pi_a, pi_b), boundary_simple, abline_simple)
  expect_equal(nrow(ep), 2)
  expect_gt(nrow(ep$exp_plots[[2]]), 0)
})

test_that("make_exp_plots rejects inconsistent harvester widths", {
  pi_a <- prep_plot("seed", "imperial", machine_width = 60, section_num = 24,
                    harvester_width = 30)
  pi_b <- prep_plot("NH3", "imperial", machine_width = 30, section_num = 1,
                    harvester_width = 60)
  expect_error(make_exp_plots(list(pi_a, pi_b), boundary_simple, abline_simple),
               "inconsistent")
})

test_that("make_exp_plots reads boundary and ab-line from file paths", {
  ep <- make_exp_plots(
    seed_plot_info(),
    file.path(ed, "boundary-simple1.shp"),
    file.path(ed, "ab-line-simple1.shp")
  )
  expect_gt(nrow(ep$exp_plots[[1]]), 0)
})

test_that("make_exp_plots shifts an ab-line that lies outside the field", {
  ab_out <- abline_simple
  sf::st_geometry(ab_out) <- sf::st_geometry(abline_simple) + c(0.02, 0)
  sf::st_crs(ab_out) <- sf::st_crs(abline_simple)
  ep <- make_exp_plots(seed_plot_info(), boundary_simple, ab_out)
  expect_gt(nrow(ep$exp_plots[[1]]), 0)
})

test_that("assign_rates_conditional rejects a list of rate infos", {
  ri <- prep_rate(nh3_plot_info(), gc_rate = 180, unit = "lb",
                  min_rate = 100, max_rate = 260, num_rates = 4)
  ep_nh3 <- make_exp_plots(nh3_plot_info(), boundary_simple, abline_simple)
  expect_error(assign_rates_conditional(ep_nh3, list(ri, ri), td_simple()),
               "two inputs")
})

test_that("assign_rates_conditional refuses a third input on mismatched geometries", {
  # existing two-input design whose inputs have different plot widths
  pi_a <- prep_plot("seed", "imperial", machine_width = 60, section_num = 24,
                    harvester_width = 30)
  pi_b <- prep_plot("uan32", "imperial", machine_width = 40, section_num = 1,
                    harvester_width = 30)
  ep_ab <- make_exp_plots(list(pi_a, pi_b), boundary_simple, abline_simple)
  ri_a <- prep_rate(pi_a, gc_rate = 34000, unit = "seeds", rates = seed_rates)
  ri_b <- prep_rate(pi_b, gc_rate = 30, unit = "gallons",
                    rates = c(10, 20, 30, 40, 50))
  set.seed(20260702)
  td_ab <- assign_rates(ep_ab, list(ri_a, ri_b))

  ri <- prep_rate(nh3_plot_info(), gc_rate = 180, unit = "lb",
                  min_rate = 100, max_rate = 260, num_rates = 4)
  ep_nh3 <- make_exp_plots(nh3_plot_info(), boundary_simple, abline_simple)
  expect_error(assign_rates_conditional(ep_nh3, ri, td_ab), "three-input")
})

test_that("assign_rates_conditional designs a third input on identical geometries", {
  pi_a <- prep_plot("seed", "imperial", machine_width = 60, section_num = 24,
                    harvester_width = 30)
  pi_b <- prep_plot("uan32", "imperial", machine_width = 60, section_num = 24,
                    harvester_width = 30)
  ep_ab <- make_exp_plots(list(pi_a, pi_b), boundary_simple, abline_simple)
  ri_a <- prep_rate(pi_a, gc_rate = 34000, unit = "seeds", rates = seed_rates)
  ri_b <- prep_rate(pi_b, gc_rate = 30, unit = "gallons",
                    rates = c(10, 20, 30, 40, 50))
  set.seed(20260702)
  td_ab <- assign_rates(ep_ab, list(ri_a, ri_b))

  pi_c <- prep_plot("NH3", "imperial", machine_width = 60, section_num = 24,
                    harvester_width = 30)
  ep_c <- make_exp_plots(pi_c, boundary_simple, abline_simple)
  ri_c <- prep_rate(pi_c, gc_rate = 180, unit = "lb", rates = c(100, 140, 180, 220, 260))
  set.seed(20260702)
  td_c <- assign_rates_conditional(ep_c, ri_c, td_ab)
  d <- td_c$trial_design[[which(td_c$input_name == "NH3")]]
  expect_gt(length(unique(d$rate[d$type == "experiment"])), 1)
})

test_that("change_rates plot mode demands plot_ids", {
  expect_error(
    change_rates(td_simple(), strip_ids = 1, plot_ids = NULL,
                 new_rates = matrix(numeric(0), nrow = 0, ncol = 1),
                 rate_by = "plot"),
    "plot_ids"
  )
})
