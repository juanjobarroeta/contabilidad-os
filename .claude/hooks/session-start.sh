#!/bin/bash
# SessionStart hook: inyecta fecha + contexto fiscal MX en el contexto de la sesión.
# Síncrono y sin dependencias (solo Node). Falla en silencio para no bloquear el
# arranque de la sesión si Node no estuviera disponible.
set -euo pipefail
node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/fiscal-clock.mjs" 2>/dev/null || true
