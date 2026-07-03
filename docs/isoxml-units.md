# ISOXML unit conversion (task 7.3)

`writeIsoxml` (`src/exports/isoxml.ts`) expresses every target rate as an
ISO 11783-11 Data Dictionary Identifier (DDI) process data value, per the
`PDV.A`/`PDV.B` pair (`ProcessDataDDI` hex string / `ProcessDataValue`
integer, per the ISO 11783-10 v3.3 XSD, `ISO11783_TaskFile_V3-3.xsd`,
`PDV` complex type). ofpetrial rates are plain numbers with a `unit` string
(`RateInfo.unit`, e.g. `"seeds"`, `"lb"`) and an implicit area basis fixed by
`PlotInfo.unit_system` (imperial → per acre, metric → per hectare) — there is
no per-rate area unit in the R data model.

DDI values were read from the live ISO 11783-11 online database
(isobus.net), not invented, on 2026-07-02:

| Rate unit family | DDI (dec/hex) | Name | DDI unit | Resolution |
| --- | --- | --- | --- | --- |
| `"seeds"` (count) | 11 / `000B` | [Setpoint Count Per Area Application Rate](https://www.isobus.net/isobus/dDEntity/24) | `/m²` | 0.001 |
| `"lb"`, `"kg"` (mass) | 6 / `0006` | [Setpoint Mass Per Area Application Rate](https://www.isobus.net/isobus/dDEntity/21) | `mg/m²` | 1 |
| `"gallons"`, `"liters"` (volume) | 1 / `0001` | [Setpoint Volume Per Area Application Rate](https://www.isobus.net/isobus/dDEntity/833) | `mm³/m²` | 0.01 |

Source: `https://www.isobus.net/isobus/exports/completeTXT` (ISO 11783-11
online database snapshot), cross-checked against the individual `dDEntity`
pages linked above.

A reviewer suggested DDI `0x0025` (37) for the seed/count case; checked
against the same live database — DDI 37 is "Actual Volume Per Time
Application Rate" (`mm³/s`, a flow rate, not a count-per-area rate), so it
was not used. DDI 11 / `000B` ("Setpoint Count Per Area Application Rate")
remains the correct choice for `"seeds"`.

## Conversion pipeline

`internal rate (per acre or per hectare) → SI rate per m² → DDI unit → raw integer (÷ resolution)`

Area basis (exact SI, not R's internal truncated constants — this is a new,
independent conversion table, so the exact international definitions apply):

- imperial: 1 acre = 4046.8564224 m²
- metric: 1 hectare = 10 000 m²

Per-unit factor to the DDI's declared unit:

| Unit | To DDI unit | Factor |
| --- | --- | --- |
| `seeds` | count → count | 1 (already a count) |
| `lb` | lb → mg | 453 592.37 (`POUNDS_TO_KG * 1e6`) |
| `kg` | kg → mg | 1 000 000 |
| `gallons` | US gal → mm³ | 3 785 411.784 (`3.785411784 L * 1e6 mm³/L`) |
| `liters` | L → mm³ | 1 000 000 |

`raw = round((rate * unitFactor / areaBasisM2) / ddiResolution)`

Example (fixture `simple1`, imperial, `seed` input, headland `gc_rate = 34000`
seeds/ac): `34000 / 4046.8564224 = 8.4025…` seeds/m² → `/ 0.001 = 8402` (DDI 11
raw value, rounded).

Example (fixture `two-input`, imperial, `NH3` input, `gc_rate = 180` lb/ac):
`180 * 453592.37 / 4046.8564224 = 20 174.9…` mg/m² → `/ 1 = 20175` (DDI 6 raw
value, rounded).

## Status: beta

R's `write_trial_files` has no ISOXML export, so there is no R reference
fixture for this format — `writeIsoxml` is verified by a round-trip test
(write → parse with an independent XML reader → assert element/attribute
counts and the numeric DDI values above), not by comparison to an R export.

Element/attribute shapes were cross-checked against **two** independent
public sources (2026-07-02):

1. `ISO11783_TaskFile_V3-3.xsd`, fetched directly from isobus.net, for
   `PFD`/`TSK`/`PDV`/`PLN`/`LSG`/`PNT`/root-element attribute letters and the
   `PolygonType`/`LinestringType`/`PointType` enumerations.
2. `dev4Agriculture/isoxml-js` (actively maintained, MIT-licensed TypeScript
   ISOXML library) — its per-entity `ATTRIBUTES` tables
   (`src/baseEntities/{Partfield,Task,TreatmentZone,ProcessDataVariable,
   Polygon,LineString,Point}.ts`) agree letter-for-letter with the XSD fetch,
   **and** independently confirm `TZN` (TreatmentZone)'s own attributes —
   the one element the XSD fetch didn't return — as `TZN.A` =
   `TreatmentZoneCode` (`xs:unsignedByte`, 0–254, required) and `TZN.B` =
   `TreatmentZoneDesignator` (string, optional).

A third source, `Open-Agriculture/AgIsoStack-plus-plus` (a reviewer
suggestion), was checked but turned out to implement ISO 11783-13 (the live
TC-BUS device-descriptor protocol: `DVC`/`DET`/`DPD`/`DPT` elements), not the
ISOXML TASKDATA field/task/geometry side (`PFD`/`TSK`/`TZN`/`PLN`/`LSG`/`PNT`)
this module needs — its one embedded ISOXML sample
(`test/ddop_tests.cpp`, `ISOXMLOutput` test) confirms the shared
`<ISO11783_TaskData VersionMajor=.. DataTransferOrigin=..>` root convention
but has no `PFD`/`TZN` content to compare against.

Per design.md D7 / tasks.md 7.3/7.5, this format stays marked **beta** until
a real ISOBUS terminal or simulator import test (task 7.5, organized with
the user) passes.

### Zone grouping and the 254-zone ceiling

`TreatmentZoneCode` (`TZN.A`) is an `xs:unsignedByte` capped at **254** (not
255 — confirmed by isoxml-js's `TreatmentZone.ATTRIBUTES.A.maxValue`), so a
task can have at most 255 treatment zones (codes 0–254). A naive "one `TZN`
per plot" design breaks this ceiling immediately (the `simple1` fixture
alone has 382 plots). Instead `writeIsoxml` groups plots by **exact rate
value** into one `TZN` per distinct rate (well under the ceiling — ofpetrial
rate tables are typically 4–7 levels plus the headland's `gc_rate`), and
lists every plot polygon sharing that rate as a separate `PLN` child of that
zone. This still gives one `PLN` per plot (per design.md D7 / spec.md), just
nested under its rate's zone instead of getting a dedicated zone. Code `0` is
reserved here as a conservative "undefined zone" convention (not a hard XSD
requirement), leaving 254 usable codes, assigned starting at `1`.

### Known beta simplifications

- No `PFD` boundary geometry (`PLN` child of `PFD`) is emitted, only the
  required `PartfieldArea` (`PFD.D`, sum of plot + headland polygon areas via
  `@turf/area`) — computing an accurate field-level union is deferred past
  the beta scope.
- Guidance lines (applicator/harvester ab-lines) are not exported to ISOXML
  (ISOXML guidance patterns, `GPN`/`GST`/`LSG` guidance sets, are out of the
  beta scope per spec.md).
