#!/usr/bin/env bash
# PostToolUse hook (Write|Edit): fast feedback — lint + typecheck ONLY on the
# package containing the edited file. Never the test suite (too slow for a hook).
# Non-blocking on success; exit 2 surfaces errors to Claude.
set -uo pipefail

file_path=$(cat | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d));
  process.stdin.on("end", () => {
    const j = JSON.parse(s);
    process.stdout.write(j.tool_input?.file_path ?? "");
  });
')

# Only source files benefit from lint/typecheck.
case "$file_path" in
  *.ts | *.tsx | *.mts | *.js | *.mjs) ;;
  *) exit 0 ;;
esac

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

# Find the owning package (nearest package.json below the repo root).
dir=$(dirname "$file_path")
pkg_name=""
while [[ "$dir" == "$repo_root"* && "$dir" != "$repo_root" ]]; do
  if [[ -f "$dir/package.json" ]]; then
    # Path passed via argv, never interpolated into JS (injection-proof).
    pkg_name=$(node -p 'require(process.argv[1]).name ?? ""' "$dir/package.json")
    break
  fi
  dir=$(dirname "$dir")
done
[[ -z "$pkg_name" ]] && exit 0

out=$(cd "$repo_root" && pnpm --filter "$pkg_name" lint 2>&1 && pnpm --filter "$pkg_name" typecheck 2>&1)
status=$?
if [[ $status -ne 0 ]]; then
  echo "lint/typecheck a échoué sur $pkg_name après édition de $file_path :" >&2
  echo "$out" | tail -30 >&2
  exit 2
fi
exit 0
