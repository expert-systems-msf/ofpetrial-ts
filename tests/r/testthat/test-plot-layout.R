test_that("make_exp_plots builds strips, plots and headlands on simple1", {
  ep <- exp_simple()
  expect_s3_class(ep$exp_plots[[1]], "sf")
  expect_s3_class(ep$headland[[1]], "sf")
  expect_true(all(c("plot_id", "strip_id") %in% names(ep$exp_plots[[1]])))
  # plot_id restarts at 1 within every strip
  by_strip <- split(ep$exp_plots[[1]]$plot_id, ep$exp_plots[[1]]$strip_id)
  expect_true(all(vapply(by_strip, function(p) min(p) == 1, logical(1))))
  expect_true(nrow(ep$ab_lines[[1]]) >= 1)
  expect_true(nrow(ep$harvest_ab_lines[[1]]) >= 1)
})

test_that("make_exp_plots handles two inputs with mutual width adjustment", {
  ep <- exp_two_input()
  expect_equal(nrow(ep), 2)
  expect_setequal(ep$input_name, c("seed", "NH3"))
  for (i in 1:2) expect_gt(nrow(ep$exp_plots[[i]]), 0)
})

test_that("make_exp_plots survives a boundary with interior holes", {
  pi <- seed_plot_info()
  ep <- make_exp_plots(pi, boundary_holes, abline_holes)
  expect_gt(nrow(ep$exp_plots[[1]]), 0)
  # plots must stay inside the outer boundary (planar ops: s2 rejects the
  # degenerate vertices this boundary produces after union)
  old_s2 <- sf::sf_use_s2(FALSE)
  on.exit(suppressMessages(sf::sf_use_s2(old_s2)), add = TRUE)
  suppressWarnings(suppressMessages({
    plots_union <- sf::st_union(sf::st_make_valid(ep$exp_plots[[1]]))
    bdry <- sf::st_transform(boundary_holes, sf::st_crs(plots_union))
    outside <- sf::st_difference(plots_union, sf::st_union(sf::st_make_valid(bdry)))
  }))
  outside_area <- if (length(outside) == 0) 0 else as.numeric(sum(sf::st_area(outside)))
  total_area <- as.numeric(sum(sf::st_area(plots_union)))
  expect_lt(outside_area / total_area, 0.01)
})

test_that("make_exp_plots supports the lock abline type", {
  pi <- seed_plot_info()
  ep <- make_exp_plots(pi, boundary_simple, abline_simple, abline_type = "lock")
  expect_equal(ep$abline_type, "lock")
  expect_gt(nrow(ep$exp_plots[[1]]), 0)
})

test_that("make_exp_plots errors on missing ab-line for non-free types", {
  pi <- seed_plot_info()
  expect_error(make_exp_plots(pi, boundary_simple, abline_data = NA, abline_type = "lock"))
})
