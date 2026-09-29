#!/usr/bin/env bash
# ============================================================================
# Restore the PRODUCTION (Customer AI + Hermes combined) repository-root
# Dockerfile after `use-as-blitz-root.sh` swapped in the Hermes-only one.
#
# Restores the byte-exact backup taken by that script. If no backup exists the
# script refuses and points at git, so the production Dockerfile is never lost.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TARGET="$REPO_ROOT/Dockerfile"
BACKUP="$SCRIPT_DIR/Dockerfile.production.bak"

if [ ! -f "$BACKUP" ]; then
  echo "No production backup at $BACKUP — nothing to restore." >&2
  echo "If the root Dockerfile was changed another way, use git instead:" >&2
  echo "  git checkout -- Dockerfile" >&2
  exit 1
fi

cp "$BACKUP" "$TARGET"
chmod 644 "$TARGET"
rm -f "$BACKUP"

echo "Root Dockerfile restored to the production (Customer AI + Hermes) image."
echo "  $TARGET"
echo
echo "The backup at $BACKUP has been removed. The production image is back in charge."
