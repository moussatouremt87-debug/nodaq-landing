-- Exécuté une seule fois, au premier démarrage de Postgres.
-- 1) Active pgvector sur la base applicative (appdb).
CREATE EXTENSION IF NOT EXISTS vector;

-- 2) Crée la base dédiée à Langfuse (observabilité LLM).
--    'CREATE DATABASE' ne supporte pas IF NOT EXISTS -> on l'encadre.
SELECT 'CREATE DATABASE langfuse'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'langfuse')\gexec
