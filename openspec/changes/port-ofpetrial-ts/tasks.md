# Tasks: port-ofpetrial-ts

## 1. Dépôt et fondations

- [x] 1.1 Créer le dépôt public `expert-systems-msf/ofpetrial-ts` (LICENSE GPL-3, README anglais avec attribution ofpetrial/Taro Mieno et al. ; nom npm `ofpetrial-ts` vérifié libre) ; cloner dans `~/Documents/GitHub/ofpetrial-ts` et y déménager ce change OpenSpec ; tout le dépôt en anglais
- [x] 1.2 Scaffolder le paquet : TypeScript strict, ESM, build tsup, tests vitest, lint, CI GitHub Actions (typecheck + tests), publication npm sur tag
- [x] 1.3 Définir les types publics : `PlotInfo`, `RateInfo`, `ExpData`, `TrialDesign` (GeoJSON + attributs, D3), erreurs typées
- [x] 1.4 Module unités : conversions impérial/métrique (ft/m, ac/ha, doses), testé unitairement contre les constantes R
- [x] 1.5 Module projection : WGS84 ↔ UTM via proj4, choix de zone depuis le centroïde (parité avec la logique R), aller-retour testé < 1 mm
- [x] 1.6 RNG seedable (PCG32/splitmix, ~30 lignes) + tests de déterminisme

## 2. Fixtures R (golden master)

- [ ] 2.1 Écrire `tools/gen-fixtures.R` : rejoue le pipeline ofpetrial 0.1.3 sur chaque cas géométrique (simple1 mono-intrant, deux-intrants, contour pathologique) **en variante impériale ET métrique** ; exporte chaque étape (PlotInfo/RateInfo JSON, parcelles/tournières GeoJSON, designs figés avec doses, sorties checks JSON, exports machine R) **+ couche sol d'entrée** (`ssurgo-simple1.geojson` depuis `system.file("extdata","ssurgo-simple1.shp",package="ofpetrial")`) **+ table de fragments `st_intersection`** sur le trial design **complet, tournières incluses** (une ligne par morceau polygone-design × polygone sol, clé `${strip_id}:${plot_id}` ou `"headland"`, `rate` du fragment + valeurs) et corrélations R de référence pour les tests de parité `checkOrthoWithChars`
- [ ] 2.2 Exécuter le script depuis ofpetrial-demo, versionner les fixtures dans `fixtures/` avec version ofpetrial + seed, vérifier la reproductibilité (relance = identique)
- [ ] 2.3 Écrire les utilitaires de comparaison du harnais : recouvrement surfacique `intersection(ts,r).area / r.area ≥ 99 %`, distance de centroïdes ≤ 10 cm, égalité numérique relative (1e-6 pour tous les diagnostics sur données pré-calculées par R — y compris corrélations sur fragments —, 1e-3 uniquement pour les corrélations issues de la jointure spatiale Turf.js complète de `checkOrthoWithChars`)
- [ ] 2.4 Définir le format neutre des cas de test (`test-cases/*.json` : entrées, sorties attendues, tolérances) + exécuteur R testthat (découverte automatique des cas, génération/validation des références)
- [ ] 2.5 Exécuteur TypeScript vitest consommant les mêmes `test-cases/` (découverte automatique, mêmes tolérances)
- [ ] 2.6 Couverture R : script `covr` sur le périmètre porté (11 fonctions + internes, exclusions viz/rapport versionnées), seuil ≥ 95 %, rapport archivé ; ajouter des cas partagés jusqu'au seuil
- [ ] 2.7 Créer `parity-map.json` (fonction R → fichier+symbole TS → cas de test) + vérification CI **limitée au job de publication (tag `v*` seulement, pas les branches)** pour ne pas bloquer le développement incrémental — rempli au fil des groupes 3 à 7
- [ ] 2.8 Script `tools/upstream-sync` : diff des sources R entre deux versions (périmètre porté), croisement avec parity-map, régénération références+fixtures, relance double suite, rapport de liste de travail ; documenter la procédure de montée de version

## 3. Configuration d'essai (trial-setup)

- [ ] 3.1 Porter `prepPlot` (défauts dérivés, validation des paramètres) — parité JSON avec les fixtures PlotInfo à 1 cm près
- [ ] 3.2 Porter `prepRate` (doses explicites, intervalle, designType par défaut, rankSeq) — parité JSON avec les fixtures RateInfo

## 4. Découpage du champ (plot-layout) — jalon : parité géométrique verte

- [ ] 4.1 Porter les primitives internes de layout (`find_center`, `make_plot_width_line`, rotation du repère sur l'ab-line, génération des bandes)
- [ ] 4.2 Porter la subdivision bandes → parcelles + tournières (contraintes min/max longueur, headland/side length)
- [ ] 4.3 Porter le rognage bandes ∩ contour via `@turf/intersect` (wrapper Turf sur `polygon-clipping` — pas d'import direct, pas de dépendance supplémentaire) + réparation d'entrée unkink+buffer(0) (équivalent st_make_valid)
- [ ] 4.3b **SI** la parité géométrique sur le cas pathologique échoue après 4.3 (recouvrement < 99 % après réparation), intégrer `geos-wasm` comme fallback de réparation et revalider — critère de sortie : parité verte sur tous les cas incluant le pathologique
- [ ] 4.4 Assembler `makeExpPlots` (mono et deux-intrants, ajustement mutuel des largeurs) — tests de parité : recouvrement ≥ 99 % (`intersection/r.area`), centroïdes ≤ 10 cm, mêmes strip_id/plot_id sur les 3 cas de fixtures (impérial + métrique)
- [ ] 4.5 Cas d'erreur : ab-line absente, contour irréparable, paramètres incohérents

## 5. Attribution des doses (rate-assignment) — jalon : propriétés vertes

- [ ] 5.1 Porter les stratégies de rangs (`gen_basic_rank_ws`, `get_starting_rank_as_ls`, `get_design_for_second`, `make_design_for_2_by_2`, etc.) pour `ls`, `str`, `rstr`, `rb`, `ejca`, `sparse` (liste vérifiée 0.1.3 ; `ejca` = nombre pair de doses ; défaut NA → `ls` + joint designing pour deux intrants) sur le RNG seedable, avec `rateJumpThreshold`
- [ ] 5.2 Assembler `assignRates` (mono et deux-intrants) — tests de propriétés : équilibre, déterminisme par seed, une dose par parcelle
- [ ] 5.3 Porter `assignRatesConditional` (design partiel deux-intrants + `get_design_for_second`) — test : combinaisons jointes équilibrées, corrélation < 0.3, erreurs sur design invalide
- [ ] 5.4 Porter `addBlocks` (partitionnement grille 2D : `block_row`/`block_col` par division entière sur `numRates`, blocs de bord partiels tolérés, `plot_id_within_block`) — test : parité exacte `block_id` + `plot_id_within_block` avec la fixture R sur design figé
- [ ] 5.5 Porter `changeRates` (rateBy all/strip/plot avec matrice en mode plot, `inputName` requis en multi-intrant, erreurs sur cibles inexistantes — déviations vs R documentées dans le spec et parity-map)

## 6. Diagnostics (design-diagnostics) — jalon : parité numérique 1e-6 sur designs figés

- [ ] 6.1 Porter `checkAlignment` (données tabulaires, pas de ggplot) — parité 1e-6 sur fixtures
- [ ] 6.2 Porter `checkOrthoInputs` (+ erreur explicite mono-intrant) — parité 1e-6
- [ ] 6.3 Porter `checkOrthoWithChars` (sémantique fragments de R : corrélation non pondérée sur la table `st_intersection` du design **complet, tournières incluses** (`rate = gcRate`), pas de moyennes par parcelle ; `vars` requis ; variables numériques/couches vectorielles seulement ; erreur si variable absente ; sorties tabulaires sans ggplot) + utilitaire public `spatialJoin` retournant `SoilFragment[]` (avec `rate` porté par fragment) — deux assertions : (a) corrélations à 1e-6 sur la table de fragments pré-calculée par R (parité pure) ; (b) corrélations à 1e-3 en jointure TS complète depuis `ssurgo-simple1.geojson` (intégration Turf.js)
- [ ] 6.4 Boucler la validation croisée : les checks portés jugent les designs de `assignRates` (5.x) — métriques dans la plage des N designs R de référence

## 7. Exports machine (machine-file-export) — jalon : relecture indépendante verte

- [ ] 7.1 Trancher shp-write vs writer maison sur pièces (test de relecture indépendante + ouverture QGIS) ; implémenter l'export Shapefile zippé (attributs rate/plot_id/strip_id/type, .prj WGS84)
- [ ] 7.2 Export GeoJSON (FeatureCollection par intrant, RFC 7946)
- [ ] 7.3 Export ISOXML : générateur TASKDATA.XML (PFD/TZN/PLN, doses converties en unités ISO) ; télécharger le XSD ISO 11783-10 depuis le portail AEF (vérifier licence redistribution) : si redistribution autorisée → versionner dans `tools/xsd/TASKDATA.xsd` + `xmllint --schema` en CI ; si redistribution interdite → téléchargement au moment du CI depuis URL AEF officielle ; si XSD inaccessible → remplacer par round-trip parse (écrire TASKDATA.XML → parser avec un parseur XML → asserter le compte d'éléments/attributs clés) ; marqué bêta dans la doc
- [ ] 7.4 API `writeTrialFiles` unifiée (ext shp/geojson/isoxml, retour Uint8Array + helper disque Node/Deno) ; CI : relecture indépendante et comparaison aux exports R des fixtures
- [ ] 7.5 Test manuel ISOXML sur terminal/simulateur ISOBUS (à organiser avec l'utilisateur ; bloquant pour retirer la mention bêta, pas pour publier) — point d'attention : les terminaux cherchent conventionnellement `TASKDATA/TASKDATA.XML` à la racine du support ; vérifier si le sous-répertoire `<inputName>/` empêche l'import direct et documenter la procédure de renommage si oui

## 8. Livraison

- [ ] 8.1 Vérifier l'exécution Deno (Supabase Edge Function d'exemple qui génère un design) et navigateur (démo minimale ou test vitest en environnement jsdom + smoke test bundle)
- [ ] 8.2 Documentation README : API complète, exemple bout-en-bout (champ → parcelles → doses → checks → exports), procédure de régénération des fixtures, correspondance des noms R ↔ TS
- [ ] 8.3 Publier `0.1.0` sur npm (compte npm de l'utilisateur — jeton à fournir) ; tag GitHub ; vérifier l'installation depuis un projet vierge
- [ ] 8.4 Proposer la suite testthat à l'upstream : adapter au format du dépôt DIFM-Brain/ofpetrial et ouvrir la pull request
