test_that("write_trial_files writes trial design, ab-lines and harvester line", {
  out <- file.path(tempdir(), "wtf-shp")
  dir.create(out, showWarnings = FALSE)
  suppressMessages(write_trial_files(td_simple(), out, ext = "shp"))
  expect_true(file.exists(file.path(out, "trial-design-seed.shp")))
  expect_true(file.exists(file.path(out, "ab-line-seed.shp")))
  expect_true(file.exists(file.path(out, "ab-line-harvester.shp")))

  # independent re-read: attributes survive the round trip
  td_back <- sf::st_read(file.path(out, "trial-design-seed.shp"), quiet = TRUE)
  expect_true(all(c("rate", "strip_id", "plot_id", "type") %in% names(td_back)))
  expect_setequal(unique(td_back$rate[td_back$type == "experiment"]), seed_rates)
})

test_that("write_trial_files writes both inputs of a two-input design", {
  out <- file.path(tempdir(), "wtf-two")
  dir.create(out, showWarnings = FALSE)
  suppressMessages(write_trial_files(td_two_input(), out, ext = "shp"))
  expect_true(file.exists(file.path(out, "trial-design-seed.shp")))
  expect_true(file.exists(file.path(out, "trial-design-NH3.shp")))
})

test_that("write_trial_files supports GDAL-driven alternate extensions", {
  out <- file.path(tempdir(), "wtf-geojson")
  dir.create(out, showWarnings = FALSE)
  suppressMessages(write_trial_files(td_simple(), out, ext = "geojson"))
  expect_true(file.exists(file.path(out, "trial-design-seed.geojson")))
  gj <- sf::st_read(file.path(out, "trial-design-seed.geojson"), quiet = TRUE)
  expect_gt(nrow(gj), 0)
})
