## ADDED Requirements

### Requirement: Export Shapefile (parité writeTrialFiles)
La bibliothèque SHALL exposer `writeTrialFiles` produisant, pour chaque intrant d'un `TrialDesign`, un Shapefile (`.shp/.shx/.dbf/.prj`) du trial design avec les attributs de la version R (au minimum `rate`, `plot_id`, `strip_id`, `type`), livré en archive zip. Comme l'export R, la couche trial design **fusionne les parcelles expérimentales et les polygones de tournière** (`type: "headland"`, `rate` = `gcRate`, `strip_id`/`plot_id` à NA/null) — c'est ce qui rend « même nombre d'entités que R » atteignable. L'environnement navigateur ne pouvant pas écrire sur disque, l'API MUST retourner des octets (`Uint8Array`/Blob) ; un chemin de sortie est accepté en Node/Deno.

**Contenu de l'archive (parité avec le zip de `write_trial_files`) :** en plus du trial design par intrant, R exporte l'ab-line applicateur par intrant (`ab-line-<input>`) et toujours l'ab-line moissonneuse (`harvester-ab-line`). L'archive TS reproduit ce contenu :
- `<inputName>/<inputName>.<ext>` — trial design (parcelles + tournières)
- `<inputName>/ab-line.<ext>` — ab-line applicateur de l'intrant
- `harvester-ab-line/harvester-ab-line.<ext>` — ab-line moissonneuse (une seule, à la racine logique de l'archive)

**Conditionnement multi-intrant :** `writeTrialFiles` produit **toujours une seule archive zip** quel que soit le nombre d'intrants. Pour un design à N intrants, l'archive contient N sous-répertoires nommés d'après l'`inputName` de chaque `PlotInfo` (propriété issue de `prepPlot`, transmise au `TrialDesign`) (ex. `nitrogen/`, `seed/`), plus le répertoire `harvester-ab-line/`. **Exception ISOXML** : le fichier de design dans le sous-répertoire est nommé `TASKDATA.XML` (exigence ISO 11783-10 — les terminaux cherchent ce nom exact) : `nitrogen/TASKDATA.XML` ; les ab-lines ne sont pas exportées en ISOXML (les lignes de guidage ISOXML — LSG — sont hors périmètre bêta). Le schéma de sous-répertoires garantit l'absence de collision de noms dans les trois formats.

#### Scenario: Shapefile lisible par les outils SIG
- **WHEN** `writeTrialFiles` exporte le design de référence (mono-intrant) en Shapefile
- **THEN** le fichier se rouvre sans erreur (vérifié dans la CI via une lecture indépendante) avec le même nombre d'entités, les mêmes attributs et des géométries équivalentes à l'export R

#### Scenario: Projection déclarée
- **WHEN** un Shapefile est produit
- **THEN** le `.prj` déclare le même CRS que l'export R (WGS84), et les coordonnées sont en WGS84

#### Scenario: Deux intrants dans une seule archive
- **WHEN** `writeTrialFiles` est appelée sur un `TrialDesign` deux-intrants (`nitrogen` + `seed`)
- **THEN** l'archive zip retournée contient exactement trois sous-répertoires — `nitrogen/`, `seed/` (chacun avec son Shapefile de design complet `<inputName>.shp/.shx/.dbf/.prj` et son ab-line applicateur `ab-line.*`) et `harvester-ab-line/` — et aucun fichier à la racine de l'archive

### Requirement: Export GeoJSON
`writeTrialFiles` SHALL aussi produire un export GeoJSON (`ext: "geojson"`) : une FeatureCollection par intrant portant les mêmes attributs que l'export Shapefile.

#### Scenario: GeoJSON conforme
- **WHEN** l'export GeoJSON est demandé
- **THEN** la sortie est un GeoJSON RFC 7946 valide, en WGS84, avec une Feature par parcelle et les propriétés `rate`, `plot_id`, `strip_id`, `type`

### Requirement: Export ISOXML
`writeTrialFiles` SHALL produire un export ISOXML (ISO 11783-10, `ext: "isoxml"`) : un `TASKDATA.XML` zippé décrivant le champ (PFD), les zones de traitement (TZN/PLN) et les doses cibles par parcelle, importable dans les terminaux compatibles ISOBUS.

#### Scenario: Structure ISOXML valide
- **WHEN** l'export ISOXML est demandé pour le design de référence
- **THEN** l'archive contient un `TASKDATA.XML` valide contre le schéma ISO 11783-10 (validation XSD en CI), avec une zone par parcelle et la dose cible correcte dans l'unité déclarée

#### Scenario: Doses converties
- **WHEN** le design utilise des unités impériales
- **THEN** les doses ISOXML sont exprimées dans l'unité SI correspondant au DDI déclaré dans le TASKDATA.XML ; la correspondance `unité interne → DDI ISO → unité SI → facteur de conversion` est versionnée dans `docs/isoxml-units.md` et le test compare la valeur numérique produite avec la valeur attendue de la fixture (ex. dose N en lb/ac → kg/ha via le facteur documenté)
