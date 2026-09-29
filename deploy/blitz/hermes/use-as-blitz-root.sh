#!/usr/bin/env bash
# ============================================================================
# Temporarily make the REPOSITORY-ROOT Dockerfile the Hermes-only one.
#
# WHY THIS EXISTS
#   The production deployment builds the repository-root `Dockerfile` (Customer
#   AI + Hermes combined). Most container platforms auto-detect that file and
#   offer no way to point them at a different one. Rather than overwrite the
#   production Dockerfile (which would break the combined deployment), this
#   script SWAPS it in and keeps a byte-exact backup, so the change is:
#     * local and instantly reversible (see restore-production-dockerfile.sh)
#     * visible in `git status` / `git diff`, so it can be committed on a
#       separate branch and pushed for a dedicated Blitz project
#
# USAGE
#   ./deploy/blitz/hermes/use-as-blitz-root.sh          # switch to Hermes-only
#   ./deploy/blitz/hermes/restore-production-dockerfile.sh   # switch back
#
# Nothing else in the repository is touched: server/, client/, hermes/,
# deploy/blitz/entrypoint.sh and deploy/blitz/supervisor.mjs are all left
# exactly as they are.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TARGET="$REPO_ROOT/Dockerfile"
SOURCE="$SCRIPT_DIR/Dockerfile"
BACKUP="$SCRIPT_DIR/Dockerfile.production.bak"

if [ ! -f "$TARGET" ]; then
  echo "ERROR: no root Dockerfile at $TARGET" >&2
  exit 1
fi
if [ ! -f "$SOURCE" ]; then
  echo "ERROR: Hermes-only Dockerfile not found at $SOURCE" >&2
  exit 1
fi

# Already swapped, and the root Dockerfile is still exactly the Hermes-only
# source we wrote: nothing to do. Idempotent re-runs must not error.
if [ -f "$BACKUP" ] && cmp -s "$SOURCE" "$TARGET"; then
  echo "Root Dockerfile is already the HERMES-ONLY image (backup preserved). Nothing to do."
  exit 0
fi

# A backup exists but the root Dockerfile is neither the backup nor our source:
# something else changed it. Refuse rather than clobber the only copy of the
# production Dockerfile.
if [ -f "$BACKUP" ]; then
  echo "ERROR: a backup exists at $BACKUP but the root Dockerfile matches neither" >&2
  echo "       the backup nor $SOURCE. Something else modified the root Dockerfile." >&2
  echo "       Resolve that by hand (see git status). Backup left untouched." >&2
  exit 1
fi

cp "$TARGET" "$BACKUP"
cp "$SOURCE" "$TARGET"
chmod 644 "$TARGET"

echo "Root Dockerfile is now the HERMES-ONLY image."
echo "  target : $TARGET"
echo "  backup : $BACKUP"
echo
echo "Next:"
echo "  1. Review:  git diff --stat"
echo "  2. Point Blitz at this branch, or keep the swap local while testing."
echo "  3. Revert:  ./deploy/blitz/hermes/restore-production-dockerfile.sh"
