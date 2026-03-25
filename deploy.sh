#!/bin/bash
# Deploy local plugin changes to all Claude Code plugin locations
SRC="$(cd "$(dirname "$0")" && pwd)"

TARGETS=(
  "$HOME/.claude/plugins/cache/claude-plugins-official/telegram/0.0.4"
  "$HOME/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram"
)

for DIR in "${TARGETS[@]}"; do
  if [ -d "$DIR" ]; then
    cp "$SRC/server.ts" "$DIR/server.ts"
    cp "$SRC/router.ts" "$DIR/router.ts"
    cp "$SRC/topic-mcp.ts" "$DIR/topic-mcp.ts"
    rm -rf "$DIR/extensions"
    cp -r "$SRC/extensions" "$DIR/extensions"
    echo "✓ deployed to $DIR"
  else
    echo "✗ not found: $DIR"
  fi
done

echo ""
echo "Restart Claude Code session to apply changes."
