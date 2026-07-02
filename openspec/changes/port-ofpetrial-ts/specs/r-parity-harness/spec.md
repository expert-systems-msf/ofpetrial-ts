## ADDED Requirements

### Requirement: Fixtures golden-master générées depuis R
Le projet SHALL fournir un script R (exécuté depuis ce dépôt, où R + ofpetrial 0.1.3 sont installés) qui rejoue le pipeline ofpetrial sur des cas de référence couvrant **les deux systèmes d'unités à profondeur égale** (chaque cas géométrique existe en variante impériale ET métrique : `boundary-simple1` mono-intrant, deux-intrants, contour pathologique) et exporte chaque étape intermédiaire en fichiers versionnés : `PlotInfo`/`RateInfo` en JSON, parcelles/tournières/ab-lines en GeoJSON, designs figés (avec doses) en GeoJSON, sorties des checks en JSON, exports machine R en zip, **et les couches de caractéristiques du sol utilisées comme entrée des checks** (`ssurgo-simple1.geojson` exporté depuis `system.file("extdata", "ssurgo-simple1.shp", package = "ofpetrial")` ainsi que la **table de fragments d'intersection** produite par R (`st_intersection(trial_design, couche_sol)` sur le design **complet — parcelles + tournières**, une ligne par morceau polygone-design × polygone sol, avec la clé composite `` `${strip_id}:${plot_id}` `` ou `"headland"`, le `rate` du fragment et les valeurs des variables) pour les tests de parité `checkOrthoWithChars`, et les corrélations R de référence). Les fixtures MUST inclure la version d'ofpetrial et le seed R utilisés.

#### Scenario: Génération reproductible
- **WHEN** le script de génération est relancé avec le même seed
- **THEN** il produit des fixtures identiques octet pour octet (hors horodatage), permettant de vérifier qu'une fixture n'a pas dérivé

### Requirement: Comparaison géométrique avec tolérance
La suite de tests TypeScript SHALL comparer les sorties de `makeExpPlots` aux fixtures R avec des métriques de tolérance : recouvrement surfacique par parcelle ≥ 99 % mesuré comme `area(intersection) / area(référence_R)`, distance de centroïde ≤ 10 cm, mêmes effectifs de bandes et parcelles, mêmes `strip_id`/`plot_id`. Un écart au-delà des tolérances MUST faire échouer la CI. La formule de recouvrement est `intersection(plotTS, plotR).area / plotR.area` — pas IoU — et MUST être définie une seule fois dans le module utilitaire du harnais, référencée depuis tous les tests de parité géométrique.

#### Scenario: Régression géométrique détectée
- **WHEN** une modification du code de layout décale les parcelles de plus de 10 cm par rapport aux fixtures
- **THEN** les tests de parité échouent en nommant les parcelles fautives et les métriques mesurées

### Requirement: Tests de propriétés pour la randomisation
Pour les fonctions randomisées (`assignRates`, `assignRatesConditional`), la suite SHALL vérifier des propriétés statistiques plutôt qu'une égalité dose à dose avec R : équilibre des doses, contraintes de voisinage du `designType`, et métriques des checks (`checkAlignment`, `checkOrthoInputs`, `checkOrthoWithChars`) dans la plage observée sur N designs R de référence. `addBlocks` étant un partitionnement en grille déterministe, elle est testée en **parité exacte** (`block_id` identiques à R sur un design figé de fixture), plus fort qu'un test de propriété.

#### Scenario: Design déséquilibré rejeté
- **WHEN** une implémentation produit une distribution de doses dont l'écart d'effectifs dépasse la tolérance de la stratégie
- **THEN** le test de propriété échoue

### Requirement: Cas de test partagés bi-runtime (R et TypeScript)
Le harnais SHALL définir les cas de test dans un format neutre versionné (`test-cases/*.json` : entrées, paramètres, sorties attendues, règles de tolérance par type de sortie). Deux exécuteurs SHALL consommer ces mêmes fichiers : un exécuteur R (testthat) qui fait tourner chaque cas contre ofpetrial et enregistre/valide les sorties de référence, et un exécuteur TypeScript (vitest) qui fait tourner chaque cas contre ofpetrial-ts et compare aux mêmes sorties de référence. Un cas de test MUST ne jamais être défini deux fois (une seule source de vérité).

#### Scenario: Même cas, deux runtimes
- **WHEN** un cas de test `make-exp-plots/simple1-mono.json` est exécuté par l'exécuteur R puis par l'exécuteur TypeScript
- **THEN** les deux valident contre les mêmes sorties de référence avec les mêmes règles de tolérance, et un échec de l'un ou l'autre est rapporté avec l'identifiant du cas

#### Scenario: Ajout d'un cas
- **WHEN** un nouveau fichier de cas est ajouté dans `test-cases/`
- **THEN** les deux exécuteurs le découvrent automatiquement (pas d'enregistrement manuel dans deux endroits)

### Requirement: Couverture quasi complète du code R porté
La suite R (testthat, écrite par ce projet — l'upstream n'a aucun test) SHALL atteindre une couverture ≥ 95 % des lignes du périmètre porté d'ofpetrial 0.1.3 (les 11 fonctions exportées et leurs internes), mesurée par `covr`. Les fichiers non portés (viz, rapport, ggplot) sont exclus de la mesure et la liste d'exclusion MUST être explicite et versionnée. Le rapport de couverture MUST être généré par le script du harnais et archivé avec les fixtures.

#### Scenario: Couverture mesurée et publiée
- **WHEN** le script de couverture est exécuté
- **THEN** il produit un rapport `covr` par fichier R, échoue si la couverture du périmètre porté passe sous 95 %, et le rapport est versionné avec l'étiquette de version ofpetrial

#### Scenario: Trou de couverture identifié
- **WHEN** une branche du code R porté n'est exercée par aucun cas de test
- **THEN** le rapport la liste nommément (fichier + lignes), et elle est soit couverte par un nouveau cas partagé, soit documentée comme inatteignable avec justification

### Requirement: Carte de correspondance R → TypeScript
Le projet SHALL maintenir une carte machine-lisible (`parity-map.json`) associant chaque fonction R portée (exportée ou interne) à son emplacement TypeScript (fichier + symbole) et aux cas de test partagés qui la couvrent. Les symboles TS internes (non exportés) sont référencés par leur nom de déclaration dans le fichier source ; un commentaire `// @parity: <nom_fonction_R>` sur chaque déclaration portée permet la vérification outillée, et tout renommage doit mettre à jour la carte. La CI MUST échouer si une fonction R du périmètre n'a pas d'entrée dans la carte, ou si une entrée pointe vers un symbole TypeScript inexistant. **Cette vérification MUST être limitée au job de publication (déclenchement sur tag `v*`) et non aux builds de branches**, afin de ne pas bloquer le développement incrémental pendant lequel la carte est remplie progressivement.

#### Scenario: Correspondance complète au moment de la publication
- **WHEN** la vérification de la carte tourne dans le job de publication (tag `v*`)
- **THEN** chaque fonction R du périmètre porté a une entrée valide (symbole TS existant + au moins un cas de test associé)

### Requirement: Procédure semi-automatique de mise à jour upstream
Le projet SHALL fournir un script de synchronisation (`tools/upstream-sync`) qui, pour une nouvelle version d'ofpetrial : (1) télécharge les sources R des deux versions et produit un diff fonction par fonction limité au périmètre porté ; (2) croise ce diff avec `parity-map.json` pour lister les modules TypeScript impactés ; (3) régénère les sorties de référence et les fixtures avec la nouvelle version R ; (4) relance la double suite et produit un rapport : fonctions R changées, modules TS à retoucher, cas de test dont les sorties de référence ont changé. La mise à jour du code TypeScript lui-même reste manuelle, mais le rapport MUST rendre la liste de travail exhaustive.

#### Scenario: Nouvelle version d'ofpetrial publiée
- **WHEN** `tools/upstream-sync` est lancé avec la version cible (ex. 0.1.4)
- **THEN** il produit un rapport listant chaque fonction R modifiée/ajoutée/supprimée du périmètre, les fichiers TypeScript correspondants via la carte, et l'état de la double suite contre les nouvelles références

#### Scenario: Changement de comportement détecté
- **WHEN** la régénération des références fait échouer des cas de test TypeScript alors que le code TS n'a pas changé
- **THEN** le rapport identifie ces cas comme « changement de comportement upstream » à traiter, distincts des régressions TS

### Requirement: Parité numérique des diagnostics sur designs figés
Les fonctions de diagnostic étant déterministes, la suite SHALL les exécuter sur des designs figés importés des fixtures R (doses incluses) et exiger l'égalité numérique avec les sorties R correspondantes, avec des tolérances différenciées par type de calcul :
- `checkAlignment` et `checkOrthoInputs` : arithmétique pure sur données déjà jointes → tolérance relative **1e-6**
- `checkOrthoWithChars` corrélations (test de parité) : les fixtures fournissent la **table de fragments d'intersection calculée par R** (`SoilFragment[]` avec `rate` porté par fragment, tournières incluses — voir design-diagnostics/spec.md) ; le test ne re-fait pas la jointure, donc les deux runtimes corrèlent les mêmes lignes → tolérance **1e-6**
- `checkOrthoWithChars` jointure spatiale (test d'intégration séparé) : exécuter le mode `soilData: GeoJSON.FeatureCollection` (jointure TS complète via `spatialJoin`) et comparer les **corrélations finales** aux corrélations R de référence → tolérance **1e-3** (les ensembles de fragments GEOS/Turf peuvent différer marginalement aux bords de parcelle ; on compare l'estimateur final, pas les fragments un à un)

#### Scenario: Parité checkAlignment et checkOrthoInputs sur designs figés
- **WHEN** `checkAlignment` et `checkOrthoInputs` tournent sur des designs figés (fixtures R, doses incluses)
- **THEN** chaque indicateur numérique est égal à la valeur R de référence à 1e-6 relatif près

#### Scenario: Parité checkOrthoWithChars — corrélations sur fragments pré-calculés
- **WHEN** `checkOrthoWithChars` tourne avec la table de fragments exportée par R depuis la fixture SSURGO (sans re-faire la jointure spatiale)
- **THEN** chaque corrélation est égale à la valeur R de référence à 1e-6 relatif près

#### Scenario: Intégration jointure spatiale Turf vs GEOS
- **WHEN** `checkOrthoWithChars` est exécutée en mode `soilData: GeoJSON.FeatureCollection` sur `ssurgo-simple1.geojson` (jointure TS complète)
- **THEN** les corrélations finales sont égales aux corrélations R de référence à 1e-3 relatif près (capture les divergences GEOS/Turf aux bords de parcelle)
