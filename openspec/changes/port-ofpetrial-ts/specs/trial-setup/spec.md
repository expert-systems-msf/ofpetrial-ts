## ADDED Requirements

### Requirement: Préparation des paramètres machine (prepPlot)
La bibliothèque SHALL exposer une fonction `prepPlot` qui valide et normalise les paramètres machine d'un intrant, avec la même sémantique que `ofpetrial::prep_plot` 0.1.3 : `inputName`, `unitSystem` (`"imperial"` | `"metric"`), `machineWidth`, `sectionNum`, `harvesterWidth`, et les optionnels `plotWidth`, `headlandLength`, `sideLength`, `maxPlotWidth`, `minPlotLength`, `maxPlotLength`. Les valeurs par défaut dérivées (largeur de parcelle, tournières) MUST reproduire les règles de calcul de la version R (conversion en mètres en interne, defaults basés sur machine/harvester width).

#### Scenario: Paramètres valides en impérial
- **WHEN** `prepPlot` est appelée avec `inputName: "NH3"`, `unitSystem: "imperial"`, `machineWidth: 60`, `sectionNum: 1`, `harvesterWidth: 30`
- **THEN** elle retourne un objet `PlotInfo` dont les largeurs, tournières et longueurs dérivées (en mètres internes) sont égales à celles produites par `prep_plot` en R sur les mêmes entrées, à 1 cm près

#### Scenario: Paramètre invalide rejeté
- **WHEN** `prepPlot` est appelée avec une largeur de machine nulle, négative ou non numérique
- **THEN** elle lève une erreur typée avec un message identifiant le paramètre fautif, sans retourner d'objet partiel

#### Scenario: Système métrique
- **WHEN** `prepPlot` est appelée avec `unitSystem: "metric"`
- **THEN** les valeurs sont interprétées en mètres sans conversion, et le `PlotInfo` porte le système d'unités pour les conversions d'affichage ultérieures

### Requirement: Préparation des doses à tester (prepRate)
La bibliothèque SHALL exposer une fonction `prepRate` équivalente à `ofpetrial::prep_rate` : à partir d'un `PlotInfo`, d'une dose de référence `gcRate`, d'une unité, et soit d'une liste explicite `rates`, soit d'un intervalle (`minRate`, `maxRate`, `numRates`), elle produit un objet `RateInfo` portant le type de design (`designType` parmi ceux supportés par R 0.1.3, liste vérifiée : `ls`, `str`, `rstr`, `rb`, `ejca`, `sparse`), les séquences de rangs optionnelles (`rankSeqWs`, `rankSeqAs`) et le seuil de saut optionnel `rateJumpThreshold` (équivalent de `rate_jump_threshold`, stocké dans le `RateInfo` et consommé par les stratégies de rangs ; défauts internes dérivés de `numRates` comme en R).

#### Scenario: Doses générées depuis un intervalle
- **WHEN** `prepRate` est appelée avec `minRate: 80`, `maxRate: 200`, `gcRate: 160`, `numRates: 5` et sans liste `rates`
- **THEN** elle génère 5 doses par le même algorithme que `get_rates` en R — séquences **ancrées sur `gcRate`** (répartition asymétrique low/high selon les écarts `maxRate - gcRate` / `gcRate - minRate`, arrondis, déduplication), `gcRate` devenant l'une des doses d'essai — et les stocke dans le `RateInfo` (mêmes valeurs que R sur les mêmes entrées)

#### Scenario: Liste explicite de doses
- **WHEN** `prepRate` reçoit `rates: [100, 130, 160, 190, 220]`
- **THEN** ces doses exactes sont utilisées et `numRates` reflète la longueur de la liste

#### Scenario: Type de design par défaut
- **WHEN** `designType` n'est pas fourni
- **THEN** la fonction retourne un `RateInfo` avec `designType: null` (équivalent de `design_type = NA` en R) ; la résolution du type effectif (toujours `"ls"` ; en deux-intrants, chemin « joint designing » — voir rate-assignment/spec.md) est déléguée à `assignRates` — `prepRate` ne choisit jamais un type par défaut

#### Scenario: gcRate conservé sans conversion
- **WHEN** `prepRate` est appelée avec `gcRate: 180` (dose de référence agriculteur)
- **THEN** le `RateInfo` retourné porte `gcRate: 180` dans les mêmes unités que l'appel, sans conversion interne. Comme en R, `gcRate` influence la génération des doses : en mode intervalle il ancre l'algorithme `get_rates` (voir scénario intervalle) ; en mode `sparse` il doit figurer dans `rates` et est réordonné en rang 1 ; en mode liste explicite (hors `sparse`) il n'altère pas les doses fournies. Il n'influence jamais le `designType`
