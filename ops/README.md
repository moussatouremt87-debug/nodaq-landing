# Stack de développement locale

Toute l'infra de dev de l'assistant IA souverain, en conteneurs. En prod, chaque
brique est remplacée par un service managé **Scaleway (région FR-PAR)**.

## Démarrage

```bash
cd ops
cp .env.example .env
docker compose up -d
docker compose ps          # tout doit être "healthy"
```

Premier lancement : ~2–3 min (téléchargement des images + migrations Langfuse/ClickHouse).

## Accès

| Service | URL / port | Notes |
|---------|-----------|-------|
| Postgres + pgvector | `localhost:5432` | bases `appdb` (app) et `langfuse` |
| Redis | `localhost:6379` | cache + files BullMQ |
| Qdrant | http://localhost:6333/dashboard | base vectorielle |
| MinIO (S3) | http://localhost:9001 | console ; identifiants = `MINIO_ROOT_*` |
| LiteLLM | http://localhost:4000 | passerelle modèles OpenAI-compatible |
| Langfuse | http://localhost:3001 | crée ton compte au 1er accès |

## Vérifs rapides

```bash
# Postgres : extension vector présente ?
docker compose exec postgres psql -U postgres -d appdb -c "\dx"

# Qdrant vivant ?
curl -s localhost:6333/healthz

# LiteLLM répond ? (nécessite une clé fournisseur dans .env pour un vrai appel)
curl -s http://localhost:4000/v1/models -H "Authorization: Bearer $LITELLM_MASTER_KEY"
```

## Cycle de vie

```bash
docker compose logs -f langfuse-web   # suivre un service
docker compose down                   # arrêter (données conservées)
docker compose down -v                # arrêter + EFFACER les volumes
```

## Notes

- **LiteLLM** : édite `litellm/config.yaml` pour pointer les vrais modèles de ta
  console Scaleway/Mistral. Sans clé fournisseur, la stack démarre mais les
  appels modèles échouent — normal tant que tu n'as pas de compte Scaleway.
- **Ports** : le port natif ClickHouse (9000) reste interne pour ne pas entrer en
  conflit avec MinIO (9000). Seul le HTTP ClickHouse (8123) est exposé.
- **Sécurité** : les secrets de `.env.example` sont pour le dev uniquement.
  Régénère-les pour tout environnement partagé (`openssl rand -hex 32`).
- **Prochaine étape** : ajouter les services applicatifs (`apps/*`, `services/*`,
  `mcp-servers/*`) à ce compose au fil des phases, ou les lancer en `pnpm dev` /
  `uv run` hors conteneur pendant le développement.
```
