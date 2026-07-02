#!/usr/bin/env Rscript
# R runner for the shared test-cases/ parity suite.
#
# Discovers every test-cases/*.json, dispatches each rParity case to the
# matching ofpetrial 0.1.3 function, and asserts the shared `expected` value
# with the case's relative tolerance — proving the frozen references really
# are R's behavior. Cases with rParity = false (documented TS deviations)
# are skipped.
#
# Usage, from the repo root:
#   Rscript tools/run-test-cases.R            # validate references
#   Rscript tools/run-test-cases.R --update   # regenerate `expected` from R

suppressPackageStartupMessages({
  library(testthat)
  library(jsonlite)
})

UPDATE <- "--update" %in% commandArgs(trailingOnly = TRUE)
CASES_DIR <- "test-cases"

ofp <- asNamespace("ofpetrial")

# Registry: shared function name -> function(input named list) -> value.
registry <- list(
  convUnit = function(input) {
    get("conv_unit", ofp)(input$value, input$from, input$to)
  },
  convertRates = function(input) {
    conversion_type <- if (is.null(input$conversionType)) "to_n_equiv" else input$conversionType
    get("convert_rates", ofp)(input$inputName, input$unit, input$rate, conversion_type)
  },
  getRates = function(input) {
    get("get_rates", ofp)(input$minRate, input$maxRate, input$gcRate, input$numLevels)
  },
  findPlotWidth = function(input) {
    get("find_plotwidth", ofp)(input$sectionWidth, input$harvesterWidth, input$maxPlotWidth)
  }
)

rel_close <- function(actual, expected, tol) {
  is.numeric(actual) &&
    length(actual) == length(expected) &&
    all(abs(actual - expected) <= tol * pmax(1, abs(expected)))
}

suite_files <- list.files(CASES_DIR, pattern = "\\.json$", full.names = TRUE)
stopifnot(length(suite_files) > 0)

n_run <- 0L
n_skipped <- 0L

for (file in suite_files) {
  suite <- jsonlite::fromJSON(file, simplifyVector = FALSE)
  updated <- FALSE

  for (i in seq_along(suite$cases)) {
    case <- suite$cases[[i]]

    if (!isTRUE(case$rParity)) {
      n_skipped <- n_skipped + 1L
      next
    }
    runner <- registry[[case$`function`]]
    if (is.null(runner)) {
      n_skipped <- n_skipped + 1L
      message(sprintf("SKIP (no R mapping yet): %s", case$name))
      next
    }

    actual <- suppressMessages(runner(case$input))

    if (UPDATE) {
      suite$cases[[i]]$expected <- actual
      updated <- TRUE
    } else {
      test_that(paste0(suite$suite, ": ", case$name), {
        expect_true(
          rel_close(actual, unlist(case$expected), case$tolerance),
          info = sprintf("actual=%s expected=%s", toString(actual), toString(case$expected))
        )
      })
    }
    n_run <- n_run + 1L
  }

  if (UPDATE && updated) {
    writeLines(
      jsonlite::toJSON(suite, digits = NA, auto_unbox = TRUE, pretty = TRUE, null = "null"),
      file
    )
    message(sprintf("Updated expected values in %s", file))
  }
}

message(sprintf("R test-case runner: %d run, %d skipped.", n_run, n_skipped))
if (!UPDATE && n_run == 0L) stop("No R-parity case was executed.")
