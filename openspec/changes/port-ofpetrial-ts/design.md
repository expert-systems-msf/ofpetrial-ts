# Design: port-ofpetrial-ts

## Context

`ofpetrial` 0.1.3 (R, GPL ≥ 3) : 14 exports, ~110 fonctions internes, ~3300 lignes déparsées, dont un gros tiers de rendu (ggplot/rapport) non porté. Le cœur géométrique travaille en UTM via `sf` (GEOS) : bandes rectangulaires alignées sur l'ab-line, rognées sur le contour, subdivisées en parcelles ; randomisation des doses par stratégies (`ls`, `str`, `rstr`, `rb`, `ejca`, `sparse` — liste vérifiée contre les sources 0.1.3 ; `jcls` cité dans d'anciennes docs n'existe pas) ; diagnostics = corrélations ; exports shapefiles.

Cible : bibliothèque TypeScript isomorphe (navigateur, Node, Deno/Supabase Edge Functions), consommée par agriprecision (Vite/React/Capacitor + Supabase, PostGIS déjà activé). Ce dépôt-ci (ofpetrial-demo) sert d'environnement R pour générer les fixtures de parité.

Décisions déjà actées avec l'utilisateur : traduction directe (GPL-3 assumée), périmètre = 11 fonctions, calculs navigateur, dépôt public séparé `expert-systems-msf/ofpetrial-ts` + paquet npm, exports Shapefile + GeoJSON + ISOXML, harnais de comparaison automatique avec R, livraison en une fois avec jalons internes.

## Goals / Non-Goals

**Goals:**
- Parité fonctionnelle et géométrique (tolérances définies dans `r-parity-harness`) avec ofpetrial 0.1.3 pour les 11 fonctions.
- API TypeScript idiomatique : GeoJSON en entrée/sortie, objets typés (`PlotInfo`, `RateInfo`, `ExpData`, `TrialDesign`), erreurs typées, RNG seedable.
- Zéro dépendance native : tourne tel quel dans un navigateur, un Web Worker, Node ≥ 20 et Deno.
- Exports machine ouvrables par les outils du terrain (validés en CI par relecture indépendante + XSD ISOXML).

**Non-Goals:**
- Pas de portage de `viz`, `make_trial_report`, `%>%` (rendu natif dans l'app consommatrice).
- Pas d'intégration agriprecision dans ce change (le paquet npm est le livrable ; l'intégration est un change ultérieur côté agriprecision).
- Pas d'analyse post-récolte (régression rendement/dose) — pipeline distinct, plus tard (stdlib-js envisageable à ce moment-là).
- Pas de reproduction bit-à-bit du RNG de R.

## Decisions

### D1 — Monorepo simple, un seul paquet npm
`expert-systems-msf/ofpetrial-ts` : un paquet `ofpetrial-ts` (ESM, types inclus), build `tsup`, tests `vitest`, publication npm via GitHub Actions sur tag. Alternative écartée : multi-paquets (core/exports/harness) — sur-découpage pour ~2000 lignes portées ; on garde des entry points séparés (`ofpetrial-ts/exports`) si le poids d'ISOXML/shapefile devient un souci de bundle.

### D2 — Géométrie : Turf.js + proj4, calcul en UTM
Comme R : reprojection WGS84 → UTM (zone du centroïde) via `proj4`, toute la construction (bandes, subdivisions, tournières) en math planaire simple (rectangles dans un repère tourné aligné sur l'ab-line — trigonométrie directe, pas Turf), `@turf/intersect` (wrapper sur `polygon-clipping` fourni par Turf — **pas d'import direct de `polygon-clipping`**, donc pas de dépendance supplémentaire à déclarer) uniquement pour le rognage bandes ∩ contour ; `@turf/area` et `@turf/centroid` pour les métriques de parité. Retour en WGS84 en sortie. Alternatives écartées : PostGIS en moteur principal (aller-retour réseau à chaque réglage, tue l'aperçu interactif — reste disponible côté Supabase pour validation/stockage) ; GEOS-WASM (~2 Mo de WASM, injustifié tant que `polygon-clipping` tient — gardé en plan B documenté si la parité géométrique échoue sur des contours pathologiques).

### D3 — Structure des données : GeoJSON + tables d'attributs

Types publics canoniques (définis en tâche 1.3) :

```ts
// Sortie de makeExpPlots, entrée de assignRates
interface InputLayout {
  plotInfo: PlotInfo;
  plots: GeoJSON.FeatureCollection;       // Feature<Polygon>, props: plot_id, strip_id
  headlands: GeoJSON.FeatureCollection;   // Feature<Polygon>, props: type: "headland"
  abLine: GeoJSON.Feature<GeoJSON.LineString>;
  guidanceLines: GeoJSON.FeatureCollection;
}
interface ExpData { inputs: InputLayout[] }
```

**Clé de parcelle canonique.** Comme en R, `plot_id` redémarre à 1 dans chaque bande (vérifié sur ofpetrial 0.1.3 : 177 parcelles, 19 bandes, 10 valeurs distinctes de `plot_id`). Seul le couple (`strip_id`, `plot_id`) identifie une parcelle. Partout où une référence par parcelle est nécessaire (fragments de `spatialJoin`, mode pré-calculé de `checkOrthoWithChars`, fixtures de fragments), la clé canonique est la chaîne composite `` `${strip_id}:${plot_id}` `` (ex. `"3:5"`). Aucun `plot_uid` supplémentaire n'est ajouté aux propriétés GeoJSON — parité de schéma d'attributs avec R.

```ts

// Sortie de assignRates / assignRatesConditional
interface InputDesign {
  plotInfo: PlotInfo;
  rateInfo: RateInfo | null;           // null = intrant non dosé (géométrie seule),
                                       // état intermédiaire avant assignRatesConditional
  plots: GeoJSON.FeatureCollection;    // props: plot_id, strip_id, type (hérités d'InputLayout)
                                       // + rate, rate_rank quand rateInfo != null
  headlands: GeoJSON.FeatureCollection;
  abLine: GeoJSON.Feature<GeoJSON.LineString>;
  guidanceLines: GeoJSON.FeatureCollection;  // conservé depuis InputLayout (jamais perdu)
}
interface TrialDesign {
  inputs: InputDesign[];
  seed: number;  // seed de la dernière randomisation (assignRates ou assignRatesConditional)
}
```

`TrialDesign` est sérialisable en JSON tel quel → persistance Supabase triviale (colonne `jsonb` ou `geometry` PostGIS via `ST_GeomFromGeoJSON`). Alternative écartée : classes riches avec méthodes — complique la sérialisation et les Web Workers.

### D4 — RNG seedable maison, propriétés plutôt que reproduction
RNG PCG32 ou splitmix (implémentation ~30 lignes, pas de dépendance), seed exposé dans l'API et stocké dans le `TrialDesign`. La parité avec R sur les parties randomisées se juge par propriétés (équilibre, contraintes de voisinage) et par les métriques des checks portés — les diagnostics servent de juges du générateur.

### D5 — Portage bottom-up, fonction interne par fonction interne
Ordre : unités/conversions → projection UTM → primitives géométriques → `prep_plot`/`prep_rate` → layout (`make_exp_plots` et ses ~15 internes : `make_trial_plots_by_input`, `find_center`, `make_plot_width_line`…) → assignation (`assign_rates*`, `get_starting_rank_as_ls`, `gen_basic_rank_ws`…) → `add_blocks`/`change_rates` → checks → exports. Chaque interne porté garde une référence en commentaire vers son homologue R (traçabilité de traduction, utile pour les futures versions d'ofpetrial).

### D6 — Fixtures R générées depuis ofpetrial-demo
Script `tools/gen-fixtures.R` dans le dépôt ofpetrial-ts, exécuté sur cette machine (R + ofpetrial déjà installés ici), sorties versionnées dans `fixtures/` du dépôt ofpetrial-ts (JSON/GeoJSON, petites). La CI TypeScript consomme les fixtures sans avoir besoin de R. Alternative écartée : R dans la CI (image lourde, fragile) — on fige les fixtures et on documente la procédure de régénération.

### D6b — Suite de tests bi-runtime et couverture R
L'upstream n'a **aucun test** (vérifié : pas de `tests/` sur DIFM-Brain/ofpetrial ni CRAN). On écrit donc la suite R nous-mêmes : cas de test en JSON neutre (`test-cases/`), exécuteur R testthat (tourne contre ofpetrial, produit/valide les références) + exécuteur vitest (tourne contre ofpetrial-ts, compare aux mêmes références). Couverture du périmètre porté mesurée par `covr`, seuil ≥ 95 % (le « près de 100 % » demandé, en excluant explicitement viz/rapport non portés). Alternative écartée : deux suites indépendantes R et TS — divergence garantie dans le temps ; le format neutre force la symétrie.

### D6c — Synchronisation upstream semi-automatique
Trois pièces : version R épinglée dans les fixtures ; `parity-map.json` (fonction R → fichier+symbole TS → cas de test) vérifiée en CI, qui formalise les commentaires de traçabilité de D5 ; script `tools/upstream-sync` qui diffe les sources R entre versions (périmètre porté seulement), croise avec la carte, régénère références + fixtures, relance la double suite et sort la liste de travail exacte. Le portage du diff reste manuel — automatiser la traduction serait illusoire — mais l'identification de quoi porter est mécanique. Alternative écartée : suivre upstream en continu (webhook CRAN) — ofpetrial publie rarement ; un lancement manuel du script à chaque release suffit.

### D7 — Exports
- **Shapefile** : `@mapbox/shp-write` essayé en premier (0.4.3, BSD-2 — compatible GPL-3 ; mais non maintenu depuis 2023-08, deps orientées navigateur dont `file-saver` suspect en Deno, limites connues sur l'enroulement des anneaux et les multi-polygones). Décision sur pièces au jalon exports via le test de relecture indépendante + QGIS ; si insuffisant, writer minimal polygone-seul ~300 lignes (format bien documenté). Zip via `fflate` dans les deux cas (pas `jszip`/`file-saver`).
- **GeoJSON** : natif, gratuit.
- **ISOXML** : générateur `TASKDATA.XML` maison (templates XML, pas de dépendance), zones de traitement par parcelle, validation XSD ISO 11783-10 en CI (xmllint). C'est le livrable le plus incertain : à valider tôt sur un terminal réel ou un simulateur (voir Risks).
- API : retourne `Uint8Array` (zip) partout ; helper Node/Deno pour écrire sur disque.

### D8 — CI de relecture indépendante des exports
Les tests de `machine-file-export` relisent les fichiers produits avec des lecteurs indépendants (`shapefile` npm pour le shp, parseur XML + XSD pour ISOXML) et comparent aux fixtures R. Empêche l'auto-validation (écrire et relire avec le même code).

## Risks / Trade-offs

- [Robustesse `polygon-clipping` sur contours dégénérés] → réparation d'entrée (équivalent `st_make_valid` : buffer(0) / unkink), fixtures incluant un contour pathologique, plan B GEOS-WASM documenté (D2).
- [ISOXML : conformité papier ≠ compatibilité terminaux réels] → validation XSD en CI + test manuel sur au moins un terminal/simulateur (jalon dédié) ; ISOXML livré marqué « bêta » dans la doc tant que non testé terrain.
- [Écarts subtils d'arrondi UTM entre proj4 et PROJ (R)] → tolérances du harnais (99 % de recouvrement, 10 cm centroïde) choisies au-dessus du bruit de reprojection attendu (< 1 mm en pratique) ; si dépassement, comparer en UTM plutôt qu'en WGS84 pour isoler la cause.
- [« Tout en une fois » : effet tunnel] → jalons internes obligatoires avec critère de sortie chiffré chacun (parité géométrique verte, propriétés vertes, exports relus verts) ; pas d'avancement au jalon suivant sans le précédent vert.
- [GPL-3 : obligation de publication] → dépôt public dès le premier commit, LICENSE + en-têtes, attribution claire d'ofpetrial (auteurs Taro Mieno et al.) dans le README.
- [Divergence future d'ofpetrial upstream] → fixtures étiquetées avec la version R exacte (0.1.3) ; montée de version = régénération des fixtures + diff.

### D9 — Décisions issues du grilling + cycle de validation (2026-07-02)
- **Unités : égalité stricte** impérial/métrique — chaque cas de fixture et de test partagé existe dans les deux systèmes, aucun mode de second rang.
- **Cible des exports : les standards du paquet R** — la référence du Shapefile est la sortie de `write_trial_files` (fixtures) ; pas de dialecte constructeur spécifique. ISOXML reste générique (validation XSD), marqué bêta.
- **Nom npm : `ofpetrial-ts`** sans organisation — disponibilité vérifiée le 2026-07-02 (`ofpetrial` aussi libre). Publication : compte npm de l'utilisateur, jeton à fournir avant la tâche 8.3.
- **Dépôt = maison du plan** : le change OpenSpec déménage dans ofpetrial-ts à sa création ; copie de travail locale `~/Documents/GitHub/ofpetrial-ts` ; ofpetrial-demo reste le labo R des fixtures.
- **Couverture R écrite en parallèle du portage** — chaque cas de test R précède le portage de sa fonction ; le seuil 95 % est atteint en fin de chantier, pas exigé au début.
- **Langue : tout en anglais** (code, API, commentaires, README, doc) — miroir naturel du paquet R, dépôt public international.
- **Jalons : critères automatiques seuls** — pas de validation humaine bloquante entre jalons ; les seuils chiffrés tranchent.
- **Suite testthat offerte à l'upstream** — PR vers DIFM-Brain/ofpetrial en fin de projet (crédibilité, canal d'alerte sur les versions futures).
- **GPL-3 consommateur** — l'importer dans agriprecision produit une œuvre combinée GPL-3 ; le statut d'agriprecision doit être clarifié avant intégration (la séparation npm ne suffit pas, contrairement à LGPL).
- **Tolérances de parité différenciées** — 1e-6 pour `checkAlignment`/`checkOrthoInputs` et pour les corrélations de `checkOrthoWithChars` sur la table de fragments pré-calculée par R (arithmétique pure sur les mêmes lignes) ; 1e-3 uniquement pour le test d'intégration en jointure TS complète (mode GeoJSON, où la divergence GEOS/Turf se manifeste — on compare les corrélations finales, pas les fragments un à un). Sémantique R vérifiée : `check_ortho_with_chars` corrèle sur les **fragments** `st_intersection` du trial design **complet — tournières incluses** (rate = gcRate, surface significative), pas sur des moyennes par parcelle.
- **`polygon-clipping` via Turf** — rognage via `@turf/intersect`, pas d'import direct de `polygon-clipping` ; pas de dépendance supplémentaire.
- **parity-map CI** — vérification de complétude limitée au job de publication (tag `v*`), pas aux branches ; le remplissage est incrémental pendant le développement.
- **SSURGO fixture** — `gen-fixtures.R` exporte aussi `ssurgo-simple1.geojson`, la table de fragments `st_intersection` du design complet (clé `${strip_id}:${plot_id}` ou `"headland"`, `rate` porté par fragment, valeurs) et les corrélations R de référence ; nécessaire pour que task 6.3 soit exécutable.

## Open Questions

- shp-write vs writer maison — tranché au jalon exports sur pièces (test de relecture par lecteur indépendant).
- Accès à un terminal ISOBUS ou simulateur pour valider l'ISOXML en conditions réelles (à organiser par l'utilisateur ; non bloquant, ISOXML publié en bêta).
