# Revue de code — ofpetrial-ts

> Audit de bugs du dépôt. **Ce document ne fait que référencer les problèmes ; aucun
> correctif n'est appliqué.** Les pistes de correction indiquées sont informatives.

- **Date :** 2026-07-06
- **Portée :** tout `src/`, `tools/`, `tests/`, `parity-map.json`
- **Baseline :** `build` + `typecheck` + `lint` + **304 tests** passent. Tous les
  problèmes ci-dessous sont donc des bugs que la suite de tests **ne détecte pas**.

## Méthode

Audit multi-agents : 12 chercheurs spécialisés par sous-système, déduplication, puis
**vérification adverse à 3 lentilles** par finding (réfuter / reproduire / juger vs. le
contrat du projet), puis un critique de complétude. La quasi-totalité des findings a été
reproduite bout-en-bout via l'API publique.

**Résultat : 38 findings bruts → 32 uniques → 30 confirmés, 2 rejetés.**

> ⚠️ Le critique de complétude n'a pas pu exécuter sa 2ᵉ ronde ciblée (limite de session
> transitoire). Il reste donc une petite marge de couverture non explorée.

## Tableau de synthèse

| # | Sévérité | Fichier:ligne | Catégorie | Titre court |
|---|----------|---------------|-----------|-------------|
| H1 | 🔴 HIGH | `src/rate-assignment.ts:758` | correctness | Plantage du design conjoint quand le 2ᵉ intrant a 2 doses |
| H2 | 🔴 HIGH | `src/rate-assignment.ts:1167` | correctness | `assignRatesConditional` aligne dosé/non-dosé par index sans vérifier les géométries |
| M1 | 🟠 MEDIUM | `src/plot-layout.ts:371` | correctness | Aire utile enclavée par un trou en C silencieusement perdue |
| M2 | 🟠 MEDIUM | `src/plot-layout.ts:912` | parity | Ab-line / guidage tronqués à la plus longue pièce |
| M3 | 🟠 MEDIUM | `src/plot-layout.ts:954` | data-corruption | Deux intrants de largeur égale partagent les mêmes objets mutables |
| M4 | 🟠 MEDIUM | `src/rate-assignment.ts:420` | silent-misbehavior | `assignLs` duplique les séquences si `rankSeqAs` trop court |
| M5 | 🟠 MEDIUM | `src/diagnostics.ts:874` | correctness | Type-classification d'après la 1ʳᵉ feature seulement |
| M6 | 🟠 MEDIUM | `src/raster.ts:66` | correctness | Signe de `yres` non fiable pour rasters ModelTransformation |
| M7 | 🟠 MEDIUM | `src/raster.ts:74` | data-corruption | Masquage nodata Float32 par égalité stricte |
| M8 | 🟠 MEDIUM | `src/units.ts:152` | numerical | Équivalent-N métrique gonflé ~2.471× |
| L1 | 🟡 LOW | `src/diagnostics.ts:454` | correctness | `checkOrthoInputs` renvoie NaN silencieux |
| L2 | 🟡 LOW | `src/diagnostics.ts:496` | parity | Gestion NA facteur incohérente live/précalculé |
| L3 | 🟡 LOW | `src/diagnostics.ts:530` | crash | `spatialJoin` plante (TypeError) sur couche non homogène |
| L4 | 🟡 LOW | `src/diagnostics.ts:883` | parity | Mode fragments applique l'intrant #1 à tous les intrants |
| L5 | 🟡 LOW | `src/exports/shapefile.ts:289` | correctness | Non-finis sérialisés en texte `NaN`/`Infinity`/`1e+21` en DBF |
| L6 | 🟡 LOW | `src/exports/shapefile.ts:344` | data-corruption | Caractères DBF en octets UTF-16 tronqués, pas de LDID/.cpg |
| L7 | 🟡 LOW | `src/exports/write-trial-files.ts:154` | data-corruption | Collision de basenames réservés écrase la couche design |
| L8 | 🟡 LOW | `src/exports/write-trial-files.ts:200` | correctness | `guidanceLines` vide : geojson/shp jettent, isoxml réussit |
| L9 | 🟡 LOW | `src/exports/write-trial-files.ts:217` | non-determinism | Zip non déterministe (fflate `Date.now()`) |
| L10 | 🟡 LOW | `src/plot-layout.ts:625` | parity | `poly_line` et ordre des features dévient de R sur strips à trous |
| L11 | 🟡 LOW | `src/rate-assignment.ts:1310` | parity | `changeRates` rejette un scalaire en mode `strip` (message contradictoire) |
| L12 | 🟡 LOW | `tools/check-parity-map.ts:30` | parity-gate | Le gate ne valide jamais `map.internals` |
| L13 | 🟡 LOW | `tools/check-parity-map.ts:40` | parity-gate | Le gate ne vérifie jamais la ré-export publique dans `src/index.ts` |
| L14 | 🟡 LOW | `parity-map.json:10` | test-coverage | `trial-setup.json` listé pour prep_plot/prep_rate n'a aucun cas |
| L15 | 🟡 LOW | `parity-map.json:151` | parity-doc | Déviation write_trial_files référence une valeur ab-line inexistante |
| L16 | 🟡 LOW | `tests/browser-smoke.test.ts:1` | test-coverage | Le smoke test n'impose pas l'invariant bundle-propre |
| L17 | 🟡 LOW | `tests/exports-shp-reader.ts:130` | test-coverage | Lecteur DBF de test trop permissif (`Number()`) |
| L18 | 🟡 LOW | `tests/parity-diagnostics.test.ts:539` | test-coverage | Cross-validation passe à vide si `correlations` vide |
| L19 | 🟡 LOW | `tests/parity-exports.test.ts:42` | test-coverage | La parité d'export ne vérifie jamais strip_id/plot_id |
| L20 | 🟡 LOW | `tests/parity-exports.test.ts:48` | test-coverage | Pas de comparaison du nombre de points par anneau |

---

## 🔴 HIGH

### H1 — Plantage systématique du design conjoint quand le 2ᵉ intrant a exactement 2 doses
**`src/rate-assignment.ts:758`** · correctness · confiance : certaine · reproduit 25/25 et 15/15 seeds

`findRate()` construit ses candidats (l.725-730) en excluant **à la fois** la dose du plot
précédent (`rateRank2ndPrev`) et celle du voisin de strip (`rateRank2ndNb`). Avec un 2ᵉ
intrant à **2 doses**, s'il n'y a que 2 candidats et que les deux voisins diffèrent, **les
deux** sont exclus → `options` est vide. Les trois paliers de repli travaillent tous sur
`options` déjà vide, y compris le « last resort » `finalOptions = options` (l.758) qui est
un no-op. Résultat : `Math.max(...[]) = -Infinity`, `tied = []`, puis `rng.sample([], 1)`
**jette** `ValidationError` à la l.762.

**Scénario de défaillance :** une expérience standard **azote(4 doses) × semence(2 doses)**
avec plots de largeur égale (donc branche conjointe `getDesignForSecond`) plante sur **tous
les seeds**. L'intrant qui plante est celui qui apparaît en **second** dans l'ordre des
intrants de l'`ExpData`, indépendamment de l'ordre du tableau `rateInfo`. Atteignable aussi
via `assignRatesConditional` quand un intrant à 2 doses est conditionné sur un design ≥4 doses.

**Piste (non appliquée) :** le dernier repli ne doit jamais rester sur `options` ; il doit
élargir à un ensemble garanti non vide, p. ex. `combEntries.filter(c => c.rateRank1 === rateRank1st)`
(ignorer l'exclusion prev/nb).

### H2 — `assignRatesConditional` aligne dosé/non-dosé par index sans vérifier que les géométries correspondent
**`src/rate-assignment.ts:1167`** · correctness · confiance : certaine · reproduit (crash ET corruption silencieuse)

`getDesignForSecond` documente une précondition (l.770) : `firstDesignRates` doit être
**aligné par rang** avec `secondFeatures`. Le caller vérifie
`geometryIdentical(matchingLayout, undosedInput)` (l.1134) mais **jamais le dosé vs le
non-dosé**. Or un design partiel à deux intrants a typiquement des largeurs machine
différentes (ex. semence 60ft vs NH3 30ft), donc les deux listes de features diffèrent en
longueur et en ordre spatial. `firstDesignRates` (l.1154) est bâti depuis `dosedInput.plots`
puis consommé positionnellement contre `matchingLayout.plots.features` (l.1167-1173).

**Deux modes de défaillance, tous deux reproduits (fixtures boundary-simple1, échelles à 5 doses) :**
- **dosé plus gros** (333 vs 108 plots) → renvoie **sans erreur**, mais l'équilibrage conjoint
  et la minimisation de corrélation ont été calculés en appariant les 108 plots non-dosés
  contre les **108 premiers** du design dosé (un coin du champ) — la propriété même que la
  fonction doit garantir est calculée sur des plots **spatialement faux**, silencieusement.
- **non-dosé plus gros** (333 vs 99) → `firstDesignRates[i]` undefined au-delà de 98 → crash
  `ValidationError: sample requires 0 <= n <= arr.length (0), got 1`.

**Piste (non appliquée) :** ajouter une garde `geometryIdentical(dosedInput.plots, matchingLayout.plots)`
(au moins sur le chemin conjoint) qui jette une erreur explicite au lieu de mal assigner ou
de planter de façon opaque.

---

## 🟠 MEDIUM

### M1 — Aire utile enclavée par un trou en C/fer-à-cheval silencieusement perdue
**`src/plot-layout.ts:371`** · correctness · certaine · reproduit

`erodeField`/`growRing` ne garde que la pièce dominante de l'offset ; pour un trou concave
dont la bouche est plus étroite que `2·inner`, l'offset s'auto-intersecte et la pièce
dominante recouvre la poche intérieure du trou. De plus le modèle `RingRegion` (l.342) ne
représente les trous que comme des anneaux positifs soustraits, donc un îlot d'aire utile
*dans* un trou est irreprésentable. `GEOS st_buffer` (R 0.1.3) calcule l'érosion de Minkowski
exacte et garde ces poches.

**Scénario :** champ 800×800 m, trou en C (murs 20 m) avec poche intérieure 220×220 m, bouche
20 m (< 2·13.64 m). TS place **0 plot** dans la poche là où R en met ~40 (≈ 20 strips × 2
plots). Le fermier perd silencieusement toute l'aire enclavée. Casse la revendication
design.md D2 (« mathématiquement équivalent au `st_intersection` de R ») ; non enregistré
dans parity-map.

### M2 — Ab-line libre et guidage moissonneuse tronqués à la plus longue pièce
**`src/plot-layout.ts:912`** · parity · certaine · reproduit

`clipFreeLine` intersecte la ligne générée avec le champ dilaté (+20 m) puis garde
**uniquement** l'intervalle le plus long (`pieces.reduce`, l.912), alors que le commentaire du
code (l.910-911) reconnaît que R garde le MULTILINESTRING complet. Dès qu'une ligne traverse
un trou > ~40 m ou une concavité, toutes les pièces sauf une disparaissent — pour l'`abLine`
applicateur **et** les `guidanceLines` moissonneuse.

**Scénario :** champ 800×600 m, ab-line nord, trou de 100 m de large (y 250..350). Sans le
trou l'ab-line couvre y [-20, 620] ; avec le trou l'ab-line et le guidage ne couvrent que
[-20, 270] — le guidage des ~55 % nord du champ (qui contient pourtant des plots) disparaît
des fichiers machine, là où R émet les deux parties. Déviation acknowledged en commentaire
seulement, non enregistrée dans parity-map ; le test asserte exactement 2 endpoints par ligne,
donc le cas multi-parties n'est pas testable.

### M3 — Deux intrants de largeur égale partagent les mêmes objets Feature mutables
**`src/plot-layout.ts:954`** · data-corruption · confiance : moyenne (2/3) · reproduit

Quand `pi2.plot_width === pi1.plot_width`, `perInput.push` (l.954) réutilise `strips1`, et les
caches (l.995, 1046) renvoient le **même** objet `FeatureCollection` pour les deux intrants :
`exp.inputs[0].plots === exp.inputs[1].plots` (mêmes objets `Feature`/`properties`), idem
headlands et guidage. En R chaque intrant est un tibble indépendant (sémantique valeur).

**Scénario :** un consommateur construit un trial à deux intrants (semence + uan32, machines
60 ft) et annote l'intrant 1 en place (`exp.inputs[0].plots.features[i].properties.rate = x`) :
les plots de l'intrant 2 portent silencieusement les mêmes mutations car ce sont les mêmes
objets. Latent dans la suite (assignRates/addBlocks/changeRates copient avant d'écrire) mais
exposé via l'API publique `ExpData`.

### M4 — `assignLs` duplique les séquences de rang quand `rankSeqAs` est plus court que `numRates`
**`src/rate-assignment.ts:420`** · silent-misbehavior · certaine · reproduit

`fullStartSeqLong` (l.402) répète `rankSeqAs` `ceil(maxStripId/numberRates)+5` fois, ce qui ne
couvre toutes les strips que si `rankSeqAs.length >= numberRates`. `rankSeqAs` est réglable par
l'utilisateur (`prepRate` option `rankSeqAs`) **sans validation de longueur**. Trop court → les
strips de queue indexent hors borne, le `!` (l.420) transforme `undefined` en `startingRank`
`undefined`, `getRankWsForStrip` calcule `indexOf(undefined) === -1`, et toutes les strips de
queue reçoivent **la même** séquence intra-strip. Le shift anti-duplication (l.443-450) ne
répare rien (lookup aussi hors borne).

**Scénario :** `prepRate(..., { rates: [5 niveaux], rankSeqAs: [2, 4] })` puis `assignRates` sur
un champ à ~30+ strips. Vérifié sur boundary-simple1 (41 strips) : strips 1-28 alternent 2,4
comme demandé ; strips 29-41 démarrent **toutes** au rang 5 (jamais listé) → 13 strips
identiques consécutives, sans erreur. R plante bruyamment dans le cas analogue.

### M5 — `checkOrthoWithChars` type-classe chaque variable d'après la 1ʳᵉ feature seulement
**`src/diagnostics.ts:874`** · correctness · certaine · reproduit

En mode FeatureCollection, `sampleValues = soilData.features[0].properties` et le garde
`typeof sampleValues[v] !== "number" && !== "string"` jette. Un GeoJSON écrit par GDAL/sf
sérialise un NA en JSON `null` : une variable `null` sur la 1ʳᵉ feature mais numérique partout
ailleurs (`typeof null === "object"`) est rejetée comme « colonne introuvable » (message
trompeur `Available columns: .`), alors que R calcule la corrélation en droppant seulement les
lignes NA. Le même sniffing 1ʳᵉ-ligne (l.891) décide numérique-vs-facteur pour **toute** la
variable : une valeur stockée comme string `"22.5"` route tout vers la branche facteur. Le
mode `SoilFragment[]` a le même défaut via `Object.hasOwn(first.values, v)` (l.862).

**Scénario :** couche SSURGO dont le 1ᵉʳ polygone a `clay = NA` (null) : `checkOrthoWithChars`
jette au lieu de renvoyer une corrélation valide sur les fragments non-NA.

### M6 — Le signe de `yres` est un indicateur north-up non fiable pour les rasters ModelTransformation
**`src/raster.ts:66`** · correctness · confiance : possible · reproduit

`RasterGrid` documente `yres < 0` = north-up, et `extractRasterMeans` s'y fie. Ça tient pour un
géoréférencement `ModelPixelScale` (getResolution renvoie `-pixelScaleY`, négatif pour
north-up), mais pour `ModelTransformation`, getResolution renvoie `-ModelTransformation[5]` ;
un raster north-up a `dY/drow < 0`, donc getResolution renvoie un `yres` **positif** →
classé south-up. Confirmé : ModelPixelScale north-up → `yres=-5`, ModelTransformation north-up
→ `yres=+5`.

**Scénario :** un GeoTIFF north-up rotation-free écrit avec un tag `ModelTransformation`
(certains exports ortho/drone) est **miroir vertical** : chaque test cellule-dans-polygone
échantillonne la mauvaise bande → moyennes sol / corrélations fausses, sans erreur.

### M7 — Masquage nodata Float32 par égalité stricte rate les sentinelles imprécises
**`src/raster.ts:74`** · data-corruption · confiance : possible · reproduit

`value === nodata` en float64 : `getGDALNoData()` parse la chaîne du tag en float64, mais une
cellule Float32 relue est le float32 élargi en float64. Quand la chaîne `GDAL_NODATA` ne
round-trip pas exactement vers ce float32, la cellule nodata **n'est pas** convertie en NaN et
entre dans la moyenne. Confirmé pour `-3.402823e+38`, `-3.4e+38`, `1.175494351e-38` ; les
sentinelles rondes (-9999, 0, NaN) round-trip et masquent correctement.

**Scénario :** GeoTIFF Float32 (pente/élévation) déclarant `GDAL_NODATA="-3.402823e+38"` :
chaque cellule nodata reste à ~-3.4028e38 au lieu de NaN et est incluse dans la moyenne du
plot → moyenne aberrante et corrélation rate/sol dénuée de sens, silencieusement.

### M8 — Équivalent-N métrique gonflé de ~2.471×
**`src/units.ts:152`** · numerical · confiance : probable · reproduit

La branche métrique convertit la dose entrante comme une **masse nue** (kg→lb ×2.2046, ou
litres→gallons) mais réexprime ensuite le **facteur** comme une **densité surfacique** (l.152 :
`convFactorN *= lb→kg × ha→acres = ×1.1209`). Convertir la valeur en masse pure tout en
convertissant le facteur en densité **double-compte la surface** : effet net ×2.471. Une dose
par hectare devrait être convertie kg/ha→lb/acre (×0.892), pas kg→lb.

**Scénario :** `convertRates('urea','kg',100)` renvoie 113.67 kg N/ha, alors que l'urée est à
46 % N → 100 kg urée/ha = 46 kg N/ha. Chaque `tgt_rate_equiv` métrique est gonflé ~2.471×.
**Impact borné :** `tgt_rate_equiv` est informatif (jamais consommé en aval dans `src/`), mais
affiché à l'utilisateur comme quantité agronomique — et contredit la note parity-map.

---

## 🟡 LOW

### Diagnostics

**L1 — `src/diagnostics.ts:454` · `checkOrthoInputs` renvoie NaN silencieux.** `if (fragments)`
traite `[]` comme table valide (troncature JS) → `weightedCorrelation` sur zéro ligne → NaN.
En mode live, la dose est lue sans vérification de présence : pour un design partiellement dosé
(`rateInfo: null` sur un intrant), chaque dose est `undefined` → NaN renvoyé. Un seuil
`if (cor > 0.5)` voit alors le design comme « passant » (toute comparaison avec NaN est fausse).

**L2 — `src/diagnostics.ts:496` · Gestion NA facteur incohérente.** `extractJoinableValues` ne
garde que number|string, donc une valeur facteur `null` produit un fragment sans la clé →
`summarizeFactorVar` la saute (live). En mode précalculé (`na = "null"`), la valeur `null` est
gardée et `String(raw)` invente une classe littéralement nommée `"null"`. Deux réponses
différentes pour les mêmes fragments ; aucune ne matche la sémantique NA-group de R
(`data.table by=`). Non enregistré dans parity-map.

**L3 — `src/diagnostics.ts:530` · `spatialJoin` plante (TypeError brut) sur couche non
homogène.** Détection de mode `soilFeatures.every(f => f.geometry?.type === "Point")` : une
seule feature Point à géométrie `null` (sortie ogr2ogr courante) ou un mix Point+Polygon fait
tomber les Points dans la branche polygone où `bboxOfGeom` déstructure un `number` →
`TypeError: number is not iterable`, au lieu de sauter la feature ou de jeter une erreur typée.

**L4 — `src/diagnostics.ts:883` · Mode fragments applique l'intrant #1 à tous les intrants.**
`td.inputs.map(...)` réutilise l'unique `soilData` pour chaque intrant : un design à deux
intrants renvoie deux entrées avec des `inputName` différents mais des corrélations
**byte-identiques** (0.99587 pour « seed » et « NH3 »). Devrait rejeter l'entrée `SoilFragment[]`
quand `td.inputs.length > 1`.

### Exports

**L5 — `src/exports/shapefile.ts:289` · Non-finis sérialisés en texte dans un champ numérique
DBF.** `toFixed`/`String(Math.trunc(...))` produit `"NaN"`, `"Infinity"`, `"1e+21"` qui passent
le contrôle de largeur et sont écrits verbatim dans le champ `N`, sans erreur — alors que le
débordement de largeur, lui, jette (`ExportError`). Une dose devenue NaN en amont est exportée
comme le texte `NaN` : succès rapporté, mais les consommateurs (terminal, GDAL, ArcGIS) lisent
du garbage.

**L6 — `src/exports/shapefile.ts:344` · Caractères DBF en octets UTF-16 tronqués.**
`bytes[o+i] = text.charCodeAt(i)` ne garde que l'octet bas : tout code point > 0xFF est mutilé
(`日` U+65E5 → 0xE5). `String(value).slice(0, length)` tronque aussi par code units (peut
casser une paire de substitution). Aucun LDID (octet 29 laissé à 0) ni `.cpg`, alors que le
master R porte LDID 0x57 (cp1252). Latent (seul champ C actuel = constante `type`).

**L7 — `src/exports/write-trial-files.ts:154` · Collision de basenames réservés.** Chaque
intrant écrit sa couche design en `<inputName>/<inputName>.<ext>` et son ab-line en
`<inputName>/ab-line.<ext>`, dans une map `entries` unique (last-write-wins).
`assertSafeInputName` whiteliste les noms ordinaires, donc un intrant nommé `ab-line` rend les
deux clés identiques → l'ab-line (écrite en second) **écrase toute la couche design**. Idem un
intrant nommé `harvester-ab-line`. Vérifié geojson + shp, sans erreur.

**L8 — `src/exports/write-trial-files.ts:200` · `guidanceLines` vide : incohérence entre
formats.** Pour geojson/shp, une `guidanceLines` vide fait jeter `ExportError('cannot write a
layer with zero features')`, alors que le chemin isoxml tolère l'absence. Le même `TrialDesign`
s'exporte proprement en ISOXML mais échoue en GeoJSON/Shapefile, bloquant l'export des couches
design + ab-line pourtant valides.

**L9 — `src/exports/write-trial-files.ts:217` · Zip non déterministe.** `zipSync(entries, { level: 9 })`
sans `mtime` : fflate estampille chaque entrée avec `Date.now()`. Deux appels à entrées
identiques produisent des archives byte-différentes (premier octet divergent à l'offset 10, le
champ DOS mod-time). Casse la reproductibilité byte-à-byte / hash de provenance / snapshots.

### Plot-layout (parité)

**L10 — `src/plot-layout.ts:625` · `poly_line` et ordre des features dévient de R sur strips
coupées par un trou.** Le fixture gelé R prouve deux écarts : (a) strips 9/19 → R `1_1/1_2` vs
TS `1_1/2_1` ; (b) strips 11-15 → R `2_1` vs TS `1_1` ; et l'**ordre** intra-strip diffère
(R met parfois la pièce à un seul plot en premier). Le test ne compare que les clés
`(strip_id, plot_id)` et la géométrie, donc ni `poly_line` ni l'ordre ne sont vérifiés. Per
CLAUDE.md, toute déviation de R doit être enregistrée dans parity-map — ce n'est pas le cas.

### Rate-assignment (parité)

**L11 — `src/rate-assignment.ts:1310` · `changeRates` rejette un scalaire en mode `strip`.**
La l.1310 exige `Array.isArray(options.newRates)` même quand `stripIds.length === 1`, alors que
le type d'option autorise `number` et que le test R miroir
(`test-rate-assignment.R:150`) montre que R accepte la forme scalaire. Le message d'erreur est
**auto-contradictoire** : « must have the same length as stripIds (1), got 1 ». Déviation non
enregistrée dans parity-map.

### Contrat parity-map & gate de publication

**L12 — `tools/check-parity-map.ts:30` · Le gate ne valide jamais `map.internals`.** La boucle
n'itère que `map.publicFunctions` ; les internals (convUnit, convertRates, utmZone, getLcm…) ne
sont jamais vérifiés. Prouvé empiriquement : renommer le `tsSymbol` d'un internal ou pointer ses
`testCases` vers un fichier inexistant donne toujours `problems found: 0`.

**L13 — `tools/check-parity-map.ts:40` · Le gate ne vérifie jamais la ré-export publique.**
`exportsSymbol` lit seulement `entry.tsFile` (le module) et jamais `src/index.ts`. Supprimer le
`export` de `makeExpPlots` depuis `src/index.ts` (donc de l'API publique du paquet, qui ne
ship que `dist/` bâti depuis `src/index.ts`) passe quand même le gate.

**L14 — `parity-map.json:10` · `trial-setup.json` listé pour prep_plot/prep_rate n'a aucun
cas.** prep_plot (l.10) et prep_rate (l.19) listent `test-cases/trial-setup.json`, mais ses 8
cas sont tous `findPlotWidth`/`getRates` — zéro `prepPlot`/`prepRate`. En plus le runner
`tests/test-cases.test.ts` n'a pas d'entrée prepPlot/prepRate (serait `it.skip`). Fausse
confiance de couverture.

**L15 — `parity-map.json:151` · Déviation write_trial_files inapplicable.** Elle affirme
`abline_type "none" excluded`, mais `write-trial-files.ts` prend un `TrialDesign` déjà bâti et
n'a **aucun** paramètre `abline_type`. En plus l'enum réel est `"non"` (pas `"none"`), donc
`makeExpPlots` jetterait sur `"none"`. La déviation documentée ne correspond à aucun code.

### Qualité des tests (régressions passant inaperçues)

**L16 — `tests/browser-smoke.test.ts:1` · Le smoke test n'impose pas l'invariant
bundle-propre.** Il tourne sous jsdom+**Node**, importe lui-même `node:fs`/`node:path`, et
jsdom ne bannit pas les builtins `node:`. Un import `node:` statique qui fuit dans le bundle ne
serait **pas** détecté. Aucune règle `no-restricted-imports` non plus. L'invariant CLAUDE.md
n'est donc pas réellement gardé.

**L17 — `tests/exports-shp-reader.ts:130` · Lecteur DBF de test trop permissif.** `Number(raw.trim())`
accepte `''→0`, `'NaN'`, `'Infinity'`, `'1e+21'`, `'0x10'`. Comme ce lecteur est la « relecture
indépendante » du writer (design.md D8), sa permissivité fait round-tripper sans anomalie le
bug L5.

**L18 — `tests/parity-diagnostics.test.ts:539` · Cross-validation passe à vide.** Toutes les
assertions vivent **dans** `for (const c of correlations)` sans garde sur `.length` et sans
assertion au niveau seed. Si `correlations` devient `[]` (régression proj4/turf, ou toutes les
variables mal classées en facteurs), zéro `expect()` s'exécute et le test passe.

**L19 — `tests/parity-exports.test.ts:42` · La parité d'export ne vérifie jamais
strip_id/plot_id.** `assertLayerParity` ne compare que `rec.type` et `rec.rate` par
enregistrement DBF. L'encodeur pourrait écrire les mauvais identifiants strip/plot (ou un
décalage) et tous les tests d'export (simple1, deux-intrants, with-holes) passeraient.

**L20 — `tests/parity-exports.test.ts:48` · Pas de comparaison du nombre de points par
anneau.** `assertLayerParity` itère sur *notre* anneau seulement et n'asserte jamais
`ring.length === rRing.length`. Une troncature d'anneau de trou (moins de points) passe
inaperçue sur les seuls fixtures multipart / à trous.

---

## Findings rejetés (par la vérification adverse)

| Fichier:ligne | Titre | Verdict |
|---------------|-------|---------|
| `src/rate-assignment.ts:1205` | addBlocks dimensionne la grille sur les doses distinctes observées | Réfuté 0/3 |
| `src/trial-setup.ts:51` | Tolérance getLcm dépendante de l'unité | Réfuté 0/3 |

---

## Priorisation suggérée (informative)

1. **H1** — plante un cas d'usage courant (4×2) sur tous les seeds.
2. **H2** — le mode « corruption silencieuse » est le plus dangereux ; a minima jeter une
   erreur explicite.
3. **M1 / M2** — perte silencieuse de surface / de guidage sur champs à trous ou concaves ;
   a minima documenter la déviation dans parity-map.
4. **L12 / L13** — trous du gate de publication ; faciles à durcir et protègent tout le reste.
