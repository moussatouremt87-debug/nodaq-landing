# @nodaq/secrets — chargement des secrets (ticket 0.3)

`.env` (dev) → **Scaleway Secret Manager** (staging/prod). Un provider unique derrière
une interface, choisi par l'environnement au boot.

## Fonctionnement

- **Dev / CI** : `EnvSecretProvider` lit `process.env` (peuplé par les `.env`
  gitignorés). Les secrets requis y ont des défauts de dev.
- **Staging / prod** : si `SCW_SECRET_KEY` est défini, `ScalewaySecretProvider`
  lit le coffre (région `fr-par`), noms préfixés par `SCW_SECRET_PREFIX`
  (ex. `nodaq-prod-AUTH_SECRET`). En `NODE_ENV=production`, le coffre est
  **obligatoire** : sans lui l'API refuse de démarrer (pas de repli silencieux
  sur des secrets en clair).
- L'injection (`injectSecrets`) n'écrase jamais une variable déjà posée :
  l'env explicite gagne (utile en CI).

## Variables d'environnement (staging/prod)

```
SCW_SECRET_KEY=...            # clé API Scaleway (elle-même fournie par le runtime)
SCW_DEFAULT_REGION=fr-par
SCW_SECRET_PREFIX=nodaq-prod-
```

## Usage (bootstrap d'un service)

```ts
import { injectSecrets } from "@nodaq/secrets";

// AVANT tout import de module qui lit process.env à l'import (@nodaq/db...)
await injectSecrets([
  { name: "AUTH_SECRET", required: isProd },
  { name: "DATABASE_URL", required: isProd },
]);
const { buildApp } = await import("./app.js");
```

## Règles

- Jamais de secret loggé ; les erreurs ne portent que des NOMS de secrets.
- Rotation du mot de passe `app_user` : mettre à jour le secret dans le coffre
  puis `ALTER ROLE app_user PASSWORD '...'` (jamais dans une migration).
- Le dossier s'appelle `secret-manager` (pas `secrets`) : la règle de sécurité
  `.claude/settings.json` interdit la lecture de tout chemin `**/secrets/**`.
