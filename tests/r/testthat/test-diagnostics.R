test_that("check_alignment returns overlap tables per input", {
  checks <- check_alignment(td_simple())
  expect_true("overlap_data" %in% names(checks))
  ov <- checks$overlap_data[[1]]
  expect_true(all(c("strip_id", "dominant_pct") %in% names(ov)))
  expect_true(all(ov$dominant_pct > 0 & ov$dominant_pct <= 1))
})

test_that("check_ortho_inputs returns a weighted correlation for two inputs", {
  cor_inputs <- suppressMessages(check_ortho_inputs(td_two_input()))
  expect_true(is.numeric(cor_inputs))
  expect_length(cor_inputs, 1)
  expect_true(abs(cor_inputs) <= 1)
})

test_that("check_ortho_inputs errors on a single-input design (upstream: cor_input never assigned)", {
  expect_error(suppressMessages(check_ortho_inputs(td_simple())), "cor_input")
})

test_that("check_ortho_with_chars correlates rates with polygon soil variables", {
  diag <- suppressWarnings(
    check_ortho_with_chars(td_simple(), sp_data_list = list(ssurgo_sf), vars_list = c("clay"))
  )
  expect_true(all(c("var", "input_name", "summary_data") %in% names(diag)))
  cor_val <- diag$summary_data[[1]]$cor_with_rate
  expect_true(is.numeric(cor_val))
  expect_true(abs(cor_val) <= 1)
})

test_that("check_ortho_with_chars handles character variables (rate means by class)", {
  diag <- suppressWarnings(
    check_ortho_with_chars(td_simple(), sp_data_list = list(ssurgo_sf), vars_list = c("musym"))
  )
  sd <- diag$summary_data[[1]]
  expect_true(all(c("rate_mean", "rate_sd") %in% names(sd)))
})

test_that("check_ortho_with_chars handles point layers via spatial join", {
  diag <- suppressWarnings(
    check_ortho_with_chars(td_simple(), sp_data_list = list(ec_sf), vars_list = c("EC_0_2"))
  )
  expect_true(is.numeric(diag$summary_data[[1]]$cor_with_rate))
})

test_that("check_ortho_with_chars handles raster layers", {
  skip_if_not_installed("terra")
  slope <- terra::rast(file.path(ed, "slope.tif"))
  var <- names(slope)[1]
  diag <- suppressWarnings(
    check_ortho_with_chars(td_simple(), sp_data_list = list(slope), vars_list = c(var))
  )
  expect_true(is.numeric(diag$summary_data[[1]]$cor_with_rate))
})
