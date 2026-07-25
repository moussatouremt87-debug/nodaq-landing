# LiteLLM gateway — même config que le compose local (ops/litellm/config.yaml),
# pointée sur Scaleway Generative APIs (souverain, FR-PAR).
# Contexte de build = RACINE du repo :  docker build -f infra/litellm/Dockerfile .

FROM ghcr.io/berriai/litellm:main-stable
COPY ops/litellm/config.yaml /app/config.yaml
CMD ["--config", "/app/config.yaml", "--port", "4000"]
