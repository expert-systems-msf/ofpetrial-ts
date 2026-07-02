## ADDED Requirements

### Requirement: Contrôle d'alignement moissonneuse (checkAlignment)
La bibliothèque SHALL exposer `checkAlignment`, équivalent de `check_alignment` : pour chaque intrant d'un `TrialDesign`, mesurer l'adéquation entre les parcelles et les passages de la moissonneuse et retourner, par intrant, les mêmes indicateurs numériques que R (proportion de passages mixtes / « mixed treatment », données par passage), sans les objets graphiques ggplot (les données nécessaires aux graphiques MUST être retournées sous forme tabulaire).

#### Scenario: Design bien aligné
- **WHEN** `checkAlignment` est exécutée sur le design de référence dont les largeurs machine/moissonneuse sont harmonieuses
- **THEN** les indicateurs numériques concordent avec ceux produits par R sur le même design figé (fixture), à la tolérance numérique près (1e-6 relative)

#### Scenario: Sortie par intrant
- **WHEN** le design contient deux intrants
- **THEN** le résultat contient une entrée par intrant, identifiée par `inputName`

### Requirement: Orthogonalité entre intrants (checkOrthoInputs)
La bibliothèque SHALL exposer `checkOrthoInputs`, équivalent de `check_ortho_inputs` : mesurer la corrélation spatiale entre les plans de doses de deux intrants et retourner la ou les mesures numériques de R (corrélation des doses appariées).

#### Scenario: Parité numérique sur design figé
- **WHEN** `checkOrthoInputs` est exécutée sur un `TrialDesign` deux-intrants importé d'une fixture R
- **THEN** la mesure de corrélation est égale à celle de R à 1e-6 près

#### Scenario: Design mono-intrant
- **WHEN** le design ne contient qu'un intrant
- **THEN** la fonction lève une erreur explicite (comportement R : contrôle applicable aux designs à deux intrants)

### Requirement: Orthogonalité vs caractéristiques du sol (checkOrthoWithChars)
La bibliothèque SHALL exposer `checkOrthoWithChars`, équivalent de `check_ortho_with_chars` : croiser les doses du design avec des caractéristiques du sol et retourner les corrélations dose ↔ caractéristique par intrant et par variable, sans objets graphiques (sorties tabulaires uniquement, comme `checkAlignment` et `checkOrthoInputs`).

**Sémantique de calcul (celle de R, vérifiée sur les sources 0.1.3) :** R ne calcule pas de moyennes par parcelle. `summarize_indiv_char` fait `st_intersection(design, couche_sol)` — produisant des **fragments** (une ligne par morceau polygone-design × polygone sol) — puis calcule `cor(rate, var)` **non pondérée sur les fragments**. Pour une couche de points, `st_join` produit une ligne par point. Point critique : le design passé à la jointure est le **trial design complet** (`rbind(experiment_design, headland)` construit dans `assign_rates`) — les **fragments de tournière** (rate = `gcRate`, ids NA) participent donc à la corrélation, et leur surface pèse bien au-delà de 1e-3. Le port TS reproduit exactement ce modèle : jointure sur parcelles **et** tournières, corrélation sur la table de fragments, pas d'agrégats par parcelle.

Le paramètre `vars: string[]` est **requis** (comme `vars_list` en R). Une variable de `vars` absente des colonnes de `soilData` déclenche l'erreur du scénario « Variable absente de la couche ». **Périmètre réduit vs R (documenté dans `parity-map.json`) :** les variables facteur/catégorielles (sortie `rate_mean`/`rate_sd` par catégorie en R) et les couches raster (`SpatRaster`) ne sont pas portées — variables numériques et couches vectorielles GeoJSON uniquement.

La fonction SHALL accepter deux modes d'entrée discriminés par le type du paramètre `soilData` :
- **`soilData: GeoJSON.FeatureCollection`** — la fonction délègue en interne à l'utilitaire `spatialJoin` pour produire la table de fragments
- **`soilData: SoilFragment[]`** (table de fragments pré-calculée, ex. exportée par R) — aucune jointure spatiale n'est effectuée, la corrélation est calculée directement sur les lignes fournies

L'utilitaire de jointure SHALL être exporté comme fonction publique de bas niveau :
```ts
interface SoilFragment {
  plotKey: string;                  // `${strip_id}:${plot_id}` (design.md D3), ou "headland" pour les fragments de tournière
  rate: number;                     // dose du polygone-design source (gcRate pour les tournières) — portée par le fragment, pas de lookup
  values: Record<string, number>;   // varName → valeur du fragment
}
spatialJoin(
  design: GeoJSON.FeatureCollection,    // trial design COMPLET : parcelles + tournières, props rate (WGS84)
  soilLayer: GeoJSON.FeatureCollection  // couche sol (WGS84)
): SoilFragment[]
```
Stratégie de jointure (celle de R) : couche **polygones** (Polygon/MultiPolygon, cas SSURGO) → un fragment par intersection non vide polygone-design × polygone sol (équivalent `st_intersection`), tournières incluses ; couche **points** → un fragment par point tombant dans un polygone-design (équivalent `st_join`). Aucune moyenne, aucun poids : la table brute est retournée. `rate` étant porté par chaque fragment, le mode pré-calculé (`soilData: SoilFragment[]`) n'exige aucun lookup par `plotKey` et encode naturellement les fragments de tournière.

Cet export permet au harnais de test de vérifier la jointure indépendamment de `checkOrthoWithChars` (test d'intégration 1e-3, défini dans `r-parity-harness/spec.md`).

Deux niveaux de tolérance pour les tests de parité : 1e-6 sur les corrélations calculées sur une table de fragments pré-calculée par R (arithmétique pure, mêmes lignes) ; 1e-3 sur les corrélations issues de la jointure TS complète (les ensembles de fragments GEOS/Turf peuvent différer marginalement aux bords) — voir r-parity-harness/spec.md § Parité numérique.

#### Scenario: Parité corrélations sur fragments pré-calculés (1e-6)
- **WHEN** `checkOrthoWithChars` est appelée avec la table de fragments exportée par R depuis la fixture SSURGO (`ssurgo-simple1`, fragments de tournière inclus avec leur `rate = gcRate`) via le mode `soilData: SoilFragment[]` et un design figé
- **THEN** les corrélations retournées sont égales à celles de `check_ortho_with_chars` en R à 1e-6 relatif près

*Le test d'intégration de la jointure spatiale (tolérance 1e-3 sur les corrélations finales) est défini dans `r-parity-harness/spec.md` § Parité numérique — il passe par le mode `soilData: GeoJSON.FeatureCollection` (jointure TS complète) et compare aux corrélations R de référence.*

#### Scenario: Variable absente de la couche
- **WHEN** une variable demandée dans `vars` n'existe pas dans la couche fournie
- **THEN** la fonction lève une erreur explicite nommant la variable et les colonnes disponibles
