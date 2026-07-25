#!/usr/bin/env bash
# PreToolUse hook (Write|Edit): blocks writes that target real secret files or
# that embed an obvious secret value. Exit 2 = block (stderr shown to Claude).
# .env.example / .env.*.example stay editable (templates, no real secrets).
set -euo pipefail

payload=$(cat)

file_path=$(printf '%s' "$payload" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d));
  process.stdin.on("end", () => {
    const j = JSON.parse(s);
    process.stdout.write(j.tool_input?.file_path ?? "");
  });
')

content=$(printf '%s' "$payload" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d));
  process.stdin.on("end", () => {
    const j = JSON.parse(s);
    const i = j.tool_input ?? {};
    process.stdout.write([i.content, i.new_string].filter(Boolean).join("\n"));
  });
')

base=$(basename "$file_path")

# 1) Real secret files: .env, .env.local, .env.production... but NOT *.example.
if [[ "$base" == .env || ( "$base" == .env.* && "$base" != *.example ) ]]; then
  echo "BLOQUÉ : écriture dans un fichier .env réel ($file_path). Les secrets vont dans le Secret Manager (prod) ou ton .env local édité À LA MAIN. .env.example reste éditable." >&2
  exit 2
fi
if [[ "$file_path" == *"/secrets/"* || "$base" == *.pem ]]; then
  echo "BLOQUÉ : écriture dans un emplacement de secrets ($file_path)." >&2
  exit 2
fi

# 2) Obvious secret values in content (long high-entropy assignments, known key shapes).
if printf '%s' "$content" | grep -qE \
  -e 'sk-(proj|ant|live)-[A-Za-z0-9_-]{16,}' \
  -e '(SECRET|API_KEY|PASSWORD|TOKEN|PRIVATE_KEY)[A-Z_]*[[:space:]]*[=:][[:space:]]*["'\'']?[A-Za-z0-9+/_-]{32,}' \
  -e 'BEGIN (RSA |EC )?PRIVATE KEY'; then
  echo "BLOQUÉ : le contenu ressemble à un secret en clair (clé API / clé privée / assignation à haute entropie). Utilise le Secret Manager ou une référence, jamais la valeur." >&2
  exit 2
fi

exit 0
