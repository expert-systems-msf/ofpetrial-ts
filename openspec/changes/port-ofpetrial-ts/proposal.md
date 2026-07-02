# Proposal: port-ofpetrial-ts

## Why

Le pipeline de conception d'essais on-farm repose aujourd'hui sur le paquet R `ofpetrial` (GPL ≥ 3), inutilisable dans la stack TypeScript d'agriprecision (navigateur React + Supabase). Un portage TypeScript fidèle permet de concevoir des essais directement dans l'application (aperçu instantané côté client, persistance Supabase/PostGIS) sans serveur R.

## What Changes

- Création d'un nouveau dépôt public `expert-systems-msf/ofpetrial-ts` (licence GPL-3, traduction directe assumée), publié comme paquet npm `ofpetrial-ts`. Dépôt entièrement en anglais ; le change OpenSpec y déménage à la création.
- Systèmes d'unités impérial et métrique traités à égalité stricte : chaque cas de test et chaque fixture existe dans les deux systèmes.
- Portage des 11 fonctions utiles d'ofpetrial 0.1.3 : `prep_plot`, `prep_rate`, `make_exp_plots`, `assign_rates`, `assign_rates_conditional`, `add_blocks`, `change_rates`, `check_alignment`, `check_ortho_inputs`, `check_ortho_with_chars`, `write_trial_files`. (`viz`, `make_trial_report` et `%>%` ne sont pas portés — rendu natif côté app.)
- Exports machine : Shapefile (parité R) + GeoJSON + ISOXML (au-delà de la version R).
- Stack : Turf.js (géométrie planaire), proj4js (WGS84 ↔ UTM), simple-statistics (stats). Calculs exécutables dans le navigateur et en Deno (Supabase Edge Functions).
- Harnais de validation contre la version R : fixtures golden-master (GeoJSON des étapes intermédiaires générées par R) comparées avec tolérance géométrique ; tests de propriétés statistiques pour les parties randomisées (l'attribution des doses ne peut pas reproduire le RNG de R).
- Suite de tests bi-runtime : cas de test partagés (JSON neutre) exécutés à la fois contre le code R original (testthat — l'upstream n'a aucun test, on écrit la suite) et contre la version TypeScript (vitest) ; couverture `covr` ≥ 95 % du périmètre R porté.
- Procédure semi-automatique de suivi upstream : version R épinglée, carte `parity-map.json` (fonction R → module TS), script `upstream-sync` qui diffe les nouvelles versions d'ofpetrial et produit la liste exacte des modules TypeScript à mettre à jour.
- Livraison complète en une fois, structurée en jalons internes vérifiables (géométrie → doses → checks → exports).

## Capabilities

### New Capabilities

- `trial-setup`: description des machines et des doses à tester (`prepPlot`, `prepRate`) — validation des paramètres, systèmes d'unités impérial/métrique.
- `plot-layout`: découpage du champ en parcelles expérimentales (`makeExpPlots`) — bandes alignées sur l'ab-line, tournières, subdivision en parcelles, géométrie en UTM.
- `rate-assignment`: attribution des doses (`assignRates`, `assignRatesConditional`, `addBlocks`, `changeRates`) — randomisation équilibrée, stratégies (`ls`, `str`, `rstr`, `rb`, `ejca`, `sparse` — liste vérifiée contre 0.1.3), doses conditionnelles par caractéristique de sol, blocs, édition manuelle.
- `design-diagnostics`: contrôles qualité du plan (`checkAlignment`, `checkOrthoInputs`, `checkOrthoWithChars`) — alignement moissonneuse, orthogonalité entre intrants et vs caractéristiques du sol.
- `machine-file-export`: export des fichiers machine (`writeTrialFiles`) — Shapefile zippé, GeoJSON, ISOXML (ISO 11783-10).
- `r-parity-harness`: harnais de comparaison automatique avec la version R — génération des fixtures depuis R, comparaison géométrique avec tolérance, tests de propriétés pour la randomisation.

### Modified Capabilities

(aucune — nouvelles capacités uniquement ; le dépôt actuel n'a pas de specs existantes)

## Impact

- **Nouveau dépôt** : `expert-systems-msf/ofpetrial-ts` (public, GPL-3, npm). Aucun code de ce dépôt-ci n'est modifié, sauf l'ajout de scripts R de génération de fixtures (utilisent l'installation R + ofpetrial locale déjà présente).
- **Dépendances** : `@turf/turf`, `proj4`, `simple-statistics`, écriture shapefile (ex. `@mapbox/shp-write` ou équivalent), zip (`fflate`).
- **Consommateur cible** : agriprecision (Vite/React/Capacitor + Supabase, PostGIS déjà activé) installera le paquet comme dépendance — intégration hors périmètre de ce change.
- **Licence** : la bibliothèque est GPL-3 (traduction directe). L'importer dans agriprecision produit une œuvre combinée soumise à GPL-3 — le statut juridique d'agriprecision doit être clarifié avec un conseiller avant la publication et l'intégration. La séparation dépôt + paquet npm n'isole pas automatiquement le consommateur (contrairement à LGPL).
