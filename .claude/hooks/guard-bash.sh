#!/usr/bin/env bash
# PreToolUse hook (Bash): blocks rm -rf outside the repo and plain `git push --force`
# (--force-with-lease stays allowed). Exit 2 = block.
# Known limit: the check is TEXTUAL on the whole command — quoting `rm -rf /x` in a
# commit message or echo triggers it. Use `git commit -F <file>` for such messages.
set -euo pipefail

command=$(cat | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d));
  process.stdin.on("end", () => {
    const j = JSON.parse(s);
    process.stdout.write(j.tool_input?.command ?? "");
  });
')

# rm -rf: positive check — any absolute/home/parent target must live under the
# project dir, everything else is blocked (no carve-outs like the old /ho hole).
if printf '%s' "$command" | grep -qE 'rm[[:space:]]+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)([[:space:]]|$)'; then
  proj="${CLAUDE_PROJECT_DIR:-$(pwd)}"
  while IFS= read -r target; do
    [[ -z "$target" ]] && continue
    t="${target%\"}" ; t="${t#\"}" ; t="${t%\'}" ; t="${t#\'}"
    t="${t/#\~/$HOME}" ; t="${t/#\$HOME/$HOME}"
    case "$t" in
      "$proj"/*) ;; # inside the project tree: allowed
      *)
        echo "BLOQUÉ : rm -rf sur '$target' (hors de l'arborescence du projet $proj)." >&2
        exit 2
        ;;
    esac
  done < <(printf '%s' "$command" | tr ' ' '\n' | grep -E '^["'\'']?(/|~|\$HOME|\.\.)')
fi

# git push --force (plain). --force-with-lease is the sanctioned alternative.
if printf '%s' "$command" | grep -qE 'git[[:space:]]+push[^|;&]*--force([[:space:]]|$)' \
  && ! printf '%s' "$command" | grep -q -- '--force-with-lease'; then
  echo "BLOQUÉ : git push --force interdit. Utilise --force-with-lease si un rewrite est vraiment nécessaire." >&2
  exit 2
fi

exit 0
