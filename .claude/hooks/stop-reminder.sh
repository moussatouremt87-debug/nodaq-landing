#!/usr/bin/env bash
# Stop hook: end-of-task reminder (the full test suite and the RGPD gate are NOT
# run by hooks — too slow / human gate).
echo "Rappel avant de considérer la tâche finie : lance 'pnpm lint && pnpm typecheck && pnpm test' (+ équivalents Python si touchés), et passe le sous-agent rgpd-security-reviewer sur tout diff touchant données/tenant/auth."
exit 0
