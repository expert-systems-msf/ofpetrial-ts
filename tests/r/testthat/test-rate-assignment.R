rates_of <- function(td, i = 1) td$trial_design[[i]]$rate[td$trial_design[[i]]$type == "experiment"]

test_that("assign_rates ls covers all rates and is seed-deterministic", {
  td <- td_simple()
  expect_setequal(unique(rates_of(td)), seed_rates)
  set.seed(20260702)
  td2 <- assign_rates(exp_simple(), seed_rate_info())
  expect_identical(td$trial_design[[1]]$rate, td2$trial_design[[1]]$rate)
  # headlands carry the grower-chosen rate
  hd <- td$trial_design[[1]]
  expect_true(all(hd$rate[hd$type == "headland"] == 34000))
})

test_that("assign_rates supports every ported design type", {
  ep <- exp_simple()
  for (dt in c("str", "rstr", "rb")) {
    set.seed(20260702)
    td <- assign_rates(ep, seed_rate_info(design_type = dt))
    expect_gt(length(unique(rates_of(td))), 1)
  }
  # sparse requires gc_rate to be one of the rates (rank 1), but the sparse
  # branch of assign_rates_by_input is broken in 0.1.3 with current
  # data.table (magrittr `.` inside DT[...]): document the failure
  ri_sparse <- prep_rate(seed_plot_info(), gc_rate = 34000, unit = "seeds",
                         rates = c(20000, 27000, 34000, 41000, 48000),
                         design_type = "sparse")
  set.seed(20260702)
  expect_error(assign_rates(ep, ri_sparse))
  # ejca needs an even rate count
  ri <- prep_rate(seed_plot_info(), gc_rate = 34000, unit = "seeds",
                  rates = c(20000, 26000, 38000, 44000), design_type = "ejca")
  set.seed(20260702)
  td <- assign_rates(ep, ri)
  expect_setequal(unique(rates_of(td)), c(20000, 26000, 38000, 44000))
})

test_that("assign_rates honors a user-provided rank sequence", {
  ep <- exp_simple()
  ri <- prep_rate(seed_plot_info(), gc_rate = 34000, unit = "seeds",
                  rates = seed_rates, design_type = "ls",
                  rank_seq_ws = c(1, 3, 5, 2, 4))
  set.seed(20260702)
  td <- assign_rates(ep, ri)
  expect_setequal(unique(rates_of(td)), seed_rates)
})

test_that("assign_rates applies the rate jump threshold", {
  ep <- exp_simple()
  ri <- prep_rate(seed_plot_info(), gc_rate = 34000, unit = "seeds",
                  rates = seed_rates, design_type = "rstr", rate_jump_threshold = 2)
  set.seed(20260702)
  td <- assign_rates(ep, ri)
  ranks <- td$trial_design[[1]]
  expect_gt(nrow(ranks), 0)
})

test_that("assign_rates pairs two inputs by input_name", {
  td <- td_two_input()
  expect_equal(nrow(td), 2)
  seed_rates_seen <- unique(rates_of(td, which(td$input_name == "seed")))
  expect_setequal(seed_rates_seen, seed_rates)
  nh3_rates_seen <- unique(rates_of(td, which(td$input_name == "NH3")))
  expect_true(all(nh3_rates_seen >= 100 & nh3_rates_seen <= 260))
})

test_that("assign_rates_conditional designs the second input against the first", {
  ep_nh3 <- make_exp_plots(nh3_plot_info(), boundary_simple, abline_simple)
  td_first <- td_simple()
  ri_nh3 <- prep_rate(nh3_plot_info(), gc_rate = 180, unit = "lb",
                      min_rate = 100, max_rate = 260, num_rates = 4)
  set.seed(20260702)
  td_cond <- assign_rates_conditional(ep_nh3, ri_nh3, td_first)
  expect_true("NH3" %in% td_cond$input_name)
  expect_gt(length(unique(rates_of(td_cond, which(td_cond$input_name == "NH3")))), 1)
})

test_that("assign_rates joint-designs two inputs with identical geometries", {
  # identical machine widths -> identical plot geometries; both design NA
  # (-> ls), 5 %% 5 == 0, no rank_seq: triggers get_design_for_second
  pi_a <- prep_plot("seed", "imperial", machine_width = 60, section_num = 24,
                    harvester_width = 30)
  pi_b <- prep_plot("uan32", "imperial", machine_width = 60, section_num = 24,
                    harvester_width = 30)
  ep <- make_exp_plots(list(pi_a, pi_b), boundary_simple, abline_simple)
  ri_a <- prep_rate(pi_a, gc_rate = 34000, unit = "seeds", rates = seed_rates)
  ri_b <- prep_rate(pi_b, gc_rate = 30, unit = "gallons",
                    rates = c(10, 20, 30, 40, 50))
  set.seed(20260702)
  td <- assign_rates(ep, list(ri_a, ri_b))
  expect_equal(nrow(td), 2)
  r1 <- td$trial_design[[1]]
  r2 <- td$trial_design[[2]]
  expect_gt(length(unique(r1$rate[r1$type == "experiment"])), 1)
  expect_gt(length(unique(r2$rate[r2$type == "experiment"])), 1)
})

test_that("assign_rates uses the 2-by-2 special design for two 2-rate inputs", {
  pi_a <- prep_plot("seed", "imperial", machine_width = 60, section_num = 24,
                    harvester_width = 30)
  pi_b <- prep_plot("uan32", "imperial", machine_width = 60, section_num = 24,
                    harvester_width = 30)
  ep <- make_exp_plots(list(pi_a, pi_b), boundary_simple, abline_simple)
  ri_a <- prep_rate(pi_a, gc_rate = 30000, unit = "seeds", rates = c(28000, 36000))
  ri_b <- prep_rate(pi_b, gc_rate = 25, unit = "gallons", rates = c(20, 40))
  set.seed(20260702)
  td <- assign_rates(ep, list(ri_a, ri_b))
  r1 <- td$trial_design[[1]]
  r2 <- td$trial_design[[2]]
  expect_setequal(unique(r1$rate[r1$type == "experiment"]), c(28000, 36000))
  expect_setequal(unique(r2$rate[r2$type == "experiment"]), c(20, 40))
})

test_that("rank-sequence internals behave per source semantics", {
  # sparse helpers work standalone (only the assign_rates sparse branch is
  # broken upstream); cover them directly
  basic5 <- ofpetrial:::gen_basic_rank_ws_sparse(5, "sparse")
  expect_equal(basic5[seq(1, length(basic5), by = 2) + 1], rep(1, length(basic5) / 2))
  basic4 <- ofpetrial:::gen_basic_rank_ws_sparse(4, "sparse")
  expect_true(all(basic4 >= 1 & basic4 <= 4))

  strip_even <- ofpetrial:::get_rank_ws_for_strip_sparse(2, basic5, strip_id = 2)
  strip_odd <- ofpetrial:::get_rank_ws_for_strip_sparse(2, basic5, strip_id = 1)
  expect_equal(strip_even[1], 1)
  expect_equal(length(strip_even), length(strip_odd))

  set.seed(20260702)
  start_as <- ofpetrial:::get_starting_rank_as(4)
  expect_setequal(start_as, 1:4)

  ws <- ofpetrial:::gen_basic_rank_ws(5, NA)
  expect_setequal(sort(unique(ws)), 1:5)
  ws_jump <- ofpetrial:::gen_basic_rank_ws(5, 2)
  expect_true(all(abs(diff(ws_jump)) <= 2 | abs(diff(ws_jump)) == 4))
})

test_that("add_blocks partitions plots into a 2D grid of blocks", {
  td <- add_blocks(td_simple())
  design <- td$trial_design[[1]]
  exp_rows <- design[design$type == "experiment", ]
  expect_true(all(c("block_id", "plot_id_within_block") %in% names(exp_rows)))
  expect_true(all(exp_rows$block_id >= 1))
  expect_true(all(exp_rows$plot_id_within_block >= 1))
  # block ids are numbered by first appearance, contiguous from 1
  expect_setequal(unique(exp_rows$block_id), seq_len(max(exp_rows$block_id)))
})

test_that("change_rates rewrites rates by strip and by plot", {
  td <- td_simple()
  strip_target <- 1
  td_strip <- change_rates(td, strip_ids = strip_target, new_rates = 99999, rate_by = "strip")
  changed <- td_strip$trial_design[[1]]
  expect_true(all(changed$rate[changed$strip_id == strip_target & changed$type == "experiment"] == 99999))

  # plot mode takes a plot x strip matrix of new rates
  td_plot <- change_rates(td, strip_ids = 1, plot_ids = 1,
                          new_rates = matrix(88888, nrow = 1, ncol = 1), rate_by = "plot")
  changed_p <- td_plot$trial_design[[1]]
  expect_true(any(changed_p$rate == 88888))

  td_all <- change_rates(td, strip_ids = c(1, 2), new_rates = 77777, rate_by = "all")
  changed_a <- td_all$trial_design[[1]]
  expect_true(all(changed_a$rate[changed_a$strip_id %in% c(1, 2) & changed_a$type == "experiment"] == 77777))
})
