## ADDED Requirements

### Requirement: Attribution des doses (assignRates)
La bibliothèque SHALL exposer une fonction `assignRates` équivalente à `ofpetrial::assign_rates` : à partir d'un `ExpData` et d'un ou plusieurs `RateInfo`, elle produit un `TrialDesign` où chaque parcelle expérimentale d'un intrant dosé porte une dose (`rate`) et un rang (`rate_rank`), selon la stratégie du `designType` (`ls` latin-square-like, `str` strip, `rstr` randomized strip, `rb` randomized block, `ejca`, `sparse` — liste vérifiée contre les sources 0.1.3 ; `ejca` exige un nombre **pair** de doses, comme le contrôle de `find_rates_data` en R). La randomisation MUST être pilotée par un générateur pseudo-aléatoire seedable propre à la bibliothèque (le RNG de R n'est pas reproduit) ; à seed égal, la sortie MUST être déterministe.

**Appariement RateInfo ↔ intrant :** toujours par `inputName` (équivalent de la jointure `left_join(…, by = "input_name")` de R), jamais par position. Un `RateInfo` dont l'`inputName` est absent de l'`ExpData` lève une erreur typée.

**Dosage partiel :** quand le nombre de `RateInfo` est inférieur au nombre d'intrants de l'`ExpData`, `assignRates` dose uniquement les intrants dont l'`inputName` a un `RateInfo` correspondant ; les intrants restants figurent dans le `TrialDesign` avec `rateInfo: null` et sans propriétés `rate`/`rate_rank` sur leurs parcelles. Ce `TrialDesign` partiel est l'entrée attendue d'`assignRatesConditional`.

#### Scenario: Résolution du designType null — mono-intrant
- **WHEN** `assignRates` reçoit un `RateInfo` avec `designType: null` et un seul intrant
- **THEN** la stratégie `ls` est appliquée (comportement R vérifié : `is.na(design_type) → "ls"`, toujours)

#### Scenario: Résolution du designType null — deux intrants (joint designing)
- **WHEN** `assignRates` reçoit deux `RateInfo` avec `designType: null` sur un `ExpData` deux-intrants dont les géométries de parcelles sont identiques, les `numRates` compatibles (multiple) et sans `rankSeq` explicite
- **THEN** le chemin « joint designing » de R est appliqué : 1er intrant en `ls`, 2e intrant via l'équivalent de l'interne `get_design_for_second` (assignation gloutonne équilibrant les combinaisons jointes de doses ; cas spécial 2×2 comme `make_design_for_2_by_2`) — **pas** la stratégie `ejca`, qui n'est jamais un défaut et requiert un choix explicite avec un nombre pair de doses. Si les conditions du joint designing ne sont pas réunies (géométries différentes, `numRates` non multiples, ou `rankSeq` fourni), chaque intrant est dosé **indépendamment** via sa propre stratégie (`ls` par défaut), comme en R

#### Scenario: Résolution du designType null — dosage partiel
- **WHEN** `assignRates` reçoit un seul `RateInfo` avec `designType: null` sur un `ExpData` deux-intrants (dosage partiel)
- **THEN** la résolution se fait sur le nombre d'intrants **dosés** : un seul → stratégie `ls` (le second intrant, non dosé, sera traité par `assignRatesConditional`)

#### Scenario: Design équilibré
- **WHEN** `assignRates` est appelée avec 5 doses sur le design de référence
- **THEN** chaque dose apparaît sur un nombre de parcelles équilibré (écart max entre doses ≤ 1 par bande, comme la stratégie R correspondante) et chaque parcelle expérimentale a exactement une dose

#### Scenario: Déterminisme par seed
- **WHEN** `assignRates` est appelée deux fois avec le même seed et les mêmes entrées
- **THEN** les deux `TrialDesign` sont identiques dose par dose

#### Scenario: Qualité statistique équivalente à R
- **WHEN** un design TypeScript et un design R sont générés sur les mêmes entrées (seeds indépendants)
- **THEN** les métriques de `checkOrthoInputs`/`checkAlignment` du design TypeScript sont dans la même plage que celles du design R (tolérance définie par le harnais de parité)

#### Scenario: Deux intrants orthogonaux
- **WHEN** `assignRates` reçoit deux `RateInfo` pour un `ExpData` à deux intrants
- **THEN** l'attribution minimise la corrélation entre les deux plans de doses par le même chemin que R (joint designing par défaut ; `ejca` seulement si demandé explicitement avec un nombre pair de doses), vérifiable par `checkOrthoInputs`

### Requirement: Doses conditionnelles (assignRatesConditional)
La bibliothèque SHALL exposer `assignRatesConditional`, équivalent de `assign_rates_conditional` : attribuer les doses d'un second intrant en prenant comme contrainte un design existant (`existingDesign: TrialDesign`), via l'équivalent de l'interne R `get_design_for_second` (assignation gloutonne qui équilibre les combinaisons jointes (dose_intrant1, dose_intrant2) sur les parcelles — pas la stratégie `ejca`). Le paramètre `existingDesign` est un `TrialDesign` à deux intrants produit par `assignRates` sur un `ExpData` deux-intrants, avec les doses assignées au premier intrant et le second intrant présent en géométrie uniquement (`rateInfo: null`, sans propriétés `rate`/`rate_rank` sur ses parcelles — voir design.md D3). La fonction accepte son propre `seed` (comme `assignRates`) ; le `TrialDesign` retourné porte ce seed (le seed du design d'entrée est remplacé — une seule valeur `seed` par `TrialDesign`, celle de la dernière randomisation).

**Périmètre réduit vs R (documenté dans `parity-map.json`) :** R accepte aussi un `existing_design` à deux intrants **déjà dosés** (géométries identiques) et conditionne alors sur les combinaisons jointes existantes. Ce cas n'est pas porté ; seul le flux design partiel (un intrant dosé, un non dosé) est supporté.

#### Scenario: Contrainte respectée
- **WHEN** `assignRatesConditional` est appelée avec un `existingDesign` (design deux-intrants issu d'`assignRates` sur un `ExpData` deux-intrants : doses assignées au 1er intrant, 5 niveaux ; 2e intrant présent en géométrie mais non dosé) et un `RateInfo` conditionnel pour le 2e intrant (5 doses)
- **THEN** les combinaisons jointes (dose_intrant1, dose_intrant2) sont équilibrées sur les parcelles (équivalent `get_design_for_second`), la corrélation de Pearson entre les deux plans de doses est inférieure à 0.3 (vérifiée par `checkOrthoInputs`), et chaque dose du 2e intrant apparaît un nombre équilibré de fois

#### Scenario: Design existant invalide
- **WHEN** `assignRatesConditional` est appelée avec un `existingDesign` absent, vide, mono-intrant, ou dont le second intrant est déjà dosé (`rateInfo != null`)
- **THEN** la fonction lève une erreur typée explicite nommant la condition violée (design deux-intrants avec exactement un intrant non dosé attendu)

### Requirement: Blocs statistiques (addBlocks)
La bibliothèque SHALL exposer `addBlocks`, équivalent de `add_blocks` : ajouter un identifiant de bloc (`block_id`) aux parcelles d'un `TrialDesign` selon le **partitionnement en grille 2D** de R (vérifié sur les sources 0.1.3) :
- `block_row = floor((plot_id - 1) / numRates) + 1`
- `block_col = floor((strip_id - 1) / numRates) + 1`
- `block_id` = numéro de la cellule (`block_row`, `block_col`), attribué dans l'**ordre de première apparition** en parcourant les parcelles du design (sémantique `.GRP` de R — pas un tri (row, col))

Un bloc complet couvre `numRates` bandes × `numRates` positions (chaque dose y apparaît ~`numRates` fois) ; les blocs de bord peuvent être **partiels** — R n'applique aucun contrôle de complétude. La fonction ajoute aussi `plot_id_within_block` (1..N séquentiel dans chaque bloc). Les parcelles de tournière (`type: "headland"`) portent `block_id` et `plot_id_within_block` à `null` (NA en R).

#### Scenario: Parité exacte sur design figé
- **WHEN** `addBlocks` est appelée sur un design figé importé d'une fixture R (doses incluses)
- **THEN** chaque parcelle porte le même `block_id` et le même `plot_id_within_block` que la sortie R de référence (la fonction est déterministe — parité exacte, pas test de propriété)

#### Scenario: Blocs de bord partiels
- **WHEN** le nombre de bandes ou de positions n'est pas un multiple de `numRates`
- **THEN** les blocs de bord sont partiels (moins de `numRates` bandes ou positions) et sont conservés tels quels, comme en R — aucune erreur, aucun rééquilibrage

### Requirement: Modification manuelle des doses (changeRates)
La bibliothèque SHALL exposer `changeRates`, reproduisant la sémantique de `change_rates` (R 0.1.3, signature vérifiée : `change_rates(td, input_name = NA, strip_ids, plot_ids = NULL, new_rates, rate_by = "all")`) :

```ts
changeRates(design: TrialDesign, opts: {
  inputName?: string;        // requis si le design a plusieurs intrants (erreur R identique)
  stripIds: number[];        // bandes ciblées — requis dans les trois modes
  plotIds?: number[];        // positions de parcelle dans les bandes ciblées
  newRates: number[] | number[][];  // scalaire déplié, vecteur, ou matrice selon rateBy
  rateBy?: "all" | "strip" | "plot";  // défaut "all", comme R
}): TrialDesign
```

Sémantique par mode (identique à R sauf déviations étiquetées — `plot_id` n'est unique que dans une bande, l'adressage individuel passe toujours par le couple bande × position) :
- `rateBy: "all"` — `newRates` est un scalaire (ou `[x]`) appliqué aux parcelles des bandes `stripIds`, intersecté avec `plotIds` si fourni. Jamais « tout le design » : R filtre toujours sur `strip_id %in% strip_ids`.
- `rateBy: "strip"` — `newRates[i]` (vecteur parallèle 1:1 à `stripIds`) est appliqué aux parcelles de la bande `stripIds[i]`, intersecté avec `plotIds` si fourni (comme R : `strip_id == strip_ids[s] & plot_id %in% plot_ids`).
- `rateBy: "plot"` — `newRates` est une matrice `number[][]` de dimensions `plotIds.length × stripIds.length` : `newRates[i][j]` est appliqué à la parcelle (`stripIds[j]`, `plotIds[i]`), comme la matrice R lignes = parcelles, colonnes = bandes. `plotIds` requis et **strictement croissant** (erreur sinon) — R applique les valeurs dans l'ordre des lignes de la table (position croissante dans la bande) ; exiger un ordre trié rend les deux formulations équivalentes.

**Déviations assumées vs R (documentées dans `parity-map.json`) :**
- *Cibles inexistantes* : R les ignore silencieusement (`ifelse`/`%in%`) ; la version TS lève une erreur explicite (voir scénario) — plus sûr pour l'utilisateur.
- *Multi-intrant* : R 0.1.3 a un bug (`dplyr::filter(input_name == input_name)`, toujours vrai) — il modifie toujours le premier intrant puis écrase les designs des deux intrants. La version TS cible correctement l'intrant nommé par `inputName`. Le cas multi-intrant est donc exclu de la parité exacte avec R (testé TS-seulement) ; le bug sera signalé à l'upstream avec la PR testthat (tâche 8.4).

#### Scenario: Changement par bande
- **WHEN** `changeRates` est appelée avec `stripIds: [3, 7]`, `newRates: [150, 90]`, `rateBy: "strip"`
- **THEN** toutes les parcelles de la bande 3 passent à 150, celles de la bande 7 à 90, aucune autre parcelle n'est modifiée

#### Scenario: Changement ciblé (rateBy all)
- **WHEN** `changeRates` est appelée avec `stripIds: [2, 4]`, `plotIds: [1, 2, 3]`, `newRates: [0]`, `rateBy: "all"`
- **THEN** les parcelles aux positions 1 à 3 des bandes 2 et 4 passent à 0, aucune autre parcelle n'est modifiée

#### Scenario: Changement par parcelle (rateBy plot, matrice)
- **WHEN** `changeRates` est appelée avec `stripIds: [2, 4]`, `plotIds: [5, 7]`, `newRates: [[100, 110], [200, 210]]`, `rateBy: "plot"`
- **THEN** la parcelle (bande 2, position 5) passe à 100, (bande 4, position 5) à 110, (bande 2, position 7) à 200, (bande 4, position 7) à 210, aucune autre parcelle n'est modifiée

#### Scenario: Intrant requis en multi-intrant
- **WHEN** `changeRates` est appelée sur un `TrialDesign` deux-intrants sans `inputName`
- **THEN** la fonction lève une erreur explicite demandant l'intrant cible (comportement R identique)

#### Scenario: Désalignement newRates/cibles
- **WHEN** les dimensions de `newRates` ne correspondent pas au mode (`length !== stripIds.length` pour `"strip"`, matrice non `plotIds.length × stripIds.length` pour `"plot"`)
- **THEN** la fonction lève une erreur explicite indiquant les dimensions attendues et reçues

#### Scenario: Cible inexistante
- **WHEN** un `stripId` inexistant, ou un `plotId` inexistant dans une bande ciblée, est fourni
- **THEN** la fonction lève une erreur explicite listant les couples (bande, position) introuvables
