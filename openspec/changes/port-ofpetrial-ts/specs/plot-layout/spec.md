## ADDED Requirements

### Requirement: Découpage du champ en parcelles (makeExpPlots)
La bibliothèque SHALL exposer une fonction `makeExpPlots` équivalente à `ofpetrial::make_exp_plots` : à partir d'un ou plusieurs `PlotInfo`, d'un contour de champ (GeoJSON Polygon/MultiPolygon, WGS84) et d'une ab-line **requise** (GeoJSON LineString, WGS84 ; `ablineType: "free" | "lock"` — la valeur R `"none"` est délibérément exclue : elle est documentée dans R 0.1.3 mais fait planter `make_exp_plots`, vérifié par exécution ; à réévaluer lors des upstream-sync), elle produit un `ExpData` contenant, par intrant : les parcelles expérimentales (polygones avec `plot_id`, `strip_id`), les tournières (headlands), l'ab-line utilisée et les lignes de guidage (si aucune ligne de guidage n'est générée, `guidanceLines` est une `FeatureCollection` vide — jamais `null`/`undefined`). Le calcul MUST se faire en coordonnées UTM métriques (zone déterminée depuis le centroïde du champ, comme en R), les résultats étant restitués en WGS84.

#### Scenario: Parité géométrique avec R sur champ de référence
- **WHEN** `makeExpPlots` est appelée avec les fixtures `boundary-simple1` + `ab-line-simple1` et le `PlotInfo` NH3 de référence (machine 60 ft, harvester 30 ft)
- **THEN** pour chaque parcelle produite par R, il existe une parcelle TypeScript de même `strip_id`/`plot_id` dont le recouvrement surfacique est ≥ 99 % et dont le centroïde est à moins de 10 cm

#### Scenario: Ab-line absente
- **WHEN** aucune ab-line n'est fournie
- **THEN** la fonction lève une erreur explicite (comportement R : ab-line requise), la génération d'une ab-line par défaut restant à la charge de l'appelant

#### Scenario: Deux intrants simultanés
- **WHEN** deux `PlotInfo` sont fournis (ex. semis + azote) avec la même boundary et la même ab-line
- **THEN** `ExpData` contient deux jeux de parcelles dont les géométries correspondent chacune à leur homologue R, y compris l'ajustement mutuel des largeurs de parcelles que fait `make_exp_plots` en mode deux-intrants

#### Scenario: Contour invalide
- **WHEN** le polygone de contour est invalide (auto-intersection) ou vide
- **THEN** la fonction tente une réparation (équivalent `st_make_valid`) et, si impossible, lève une erreur explicite plutôt que de produire des parcelles corrompues

### Requirement: Parcelles conformes aux contraintes machine
Les parcelles générées MUST respecter les contraintes du `PlotInfo` : largeur de parcelle multiple cohérent de la largeur machine/sections, longueur entre `minPlotLength` et `maxPlotLength`, tournières d'au moins `headlandLength` aux extrémités et `sideLength` sur les côtés.

#### Scenario: Largeur de parcelle
- **WHEN** un design est généré avec `machineWidth: 60 ft`, `sectionNum: 1`, `harvesterWidth: 30 ft`
- **THEN** la largeur de chaque parcelle est identique à celle retenue par R pour la même configuration (règle du plus petit commun multiple machine/moissonneuse)

#### Scenario: Tournières
- **WHEN** le design est généré
- **THEN** aucune parcelle expérimentale n'empiète sur la zone de tournière, et la zone de tournière est couverte par des polygones marqués `type: "headland"`
