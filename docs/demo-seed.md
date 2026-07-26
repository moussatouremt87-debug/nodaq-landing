# Seed démo — tenant « Élec Provence »

Une commande, un état : `pnpm seed:demo` crée — ou **remet à neuf** — le tenant de
démonstration « Élec Provence » (SARL d'électricité générale, 6 salariés), aligné sur
le kit de démo. À lancer **avant chaque rendez-vous** : les validations faites en démo
« consomment » les données, le seed les restaure à l'identique.

## Quand et comment

```bash
# Local (infra ops/ démarrée, migrations appliquées).
# `read -s` : le mot de passe ne finit ni dans l'historique du shell ni dans
# la ligne de commande visible — ne le passez pas en préfixe de commande.
read -s DEMO_USER_PASSWORD && export DEMO_USER_PASSWORD
pnpm seed:demo
```

- **Connexion** : `demo@nodaq.fr` / le mot de passe passé en env (jamais en dur).
- **Rejouable** : chaque exécution supprime et recrée les données du tenant démo
  (y compris les `pending_actions` déjà validées). Aucune autre organisation n'est
  touchée — les écritures métier passent par `withTenant` (RLS).
- **Staging/production** : refus si `NODE_ENV=production`, sauf
  `DEMO_SEED_ALLOWED=true` explicite (staging uniquement — jamais sur une base
  contenant des données réelles).

## Ce que la démo contient

- **Connecteurs Qonto/Pennylane en statut « Démo »** (badge dans l'UI — jamais
  « connecté ») : les données bancaires et factures viennent de fixtures à **dates
  relatives** (`@nodaq/mcp-connectors`, `src/demo.ts`), zéro réseau, zéro secret.
- **Trésorerie** : solde 14 660 €, projection avec **creux à 8 900 € à J+30**
  (recalculée à la demande par le cockpit — rien n'est stocké).
- **7 factures clients dont 3 en retard = 8 030 € d'impayés** : SCCV Les Terrasses
  du Parc (4 200 €, 18 j), Syndic Lemaire & Associés (2 650 €, 9 j), Entreprise
  Générale Bardin (1 180 €, 5 j).
- **5 `pending_actions`** : 3 relances rédigées (vocabulaire chantier, art. L441-10),
  1 devis DV-0455 (M. Bernard, 12 800 €), 1 rapprochement (3 écritures, 6 410 €).

## À ne pas faire

- Ne jamais réutiliser ce script comme base d'un « import client » : c'est un outil
  de démo, pas un outil de données.
- Ne jamais poser le statut connecteur `demo` ailleurs que via ce script —
  l'onboarding API ne crée que `active`, après test réel des identifiants.
