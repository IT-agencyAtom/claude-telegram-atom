#!/bin/bash
# Install telegram@atom-plugins for Claude Code
#
# For manual install. If the marketplace is already added, just run:
#   /plugin install telegram@atom-plugins
#
# Usage: bash install.sh

set -e

SRC="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$HOME/.claude/plugins/marketplaces/atom-plugins/external_plugins/telegram"
SETTINGS="$HOME/.claude/settings.json"

# Create symlink (or replace existing)
mkdir -p "$(dirname "$PLUGIN_DIR")"
if [ -L "$PLUGIN_DIR" ]; then
  rm "$PLUGIN_DIR"
elif [ -d "$PLUGIN_DIR" ]; then
  rm -rf "$PLUGIN_DIR"
fi
ln -s "$SRC" "$PLUGIN_DIR"
echo "✓ linked $PLUGIN_DIR → $SRC"

# Enable plugin in settings.json
if [ -f "$SETTINGS" ]; then
  if ! grep -q '"telegram@atom-plugins"' "$SETTINGS"; then
    python3 -c "
import json
with open('$SETTINGS') as f:
    d = json.load(f)
d.setdefault('enabledPlugins', {})['telegram@atom-plugins'] = True
with open('$SETTINGS', 'w') as f:
    json.dump(d, f, indent=2)
    f.write('\n')
print('✓ enabled telegram@atom-plugins in settings.json')
"
  else
    echo "✓ already enabled in settings.json"
  fi
else
  echo "✗ settings.json not found at $SETTINGS"
fi

echo ""
echo "Done! Launch with:"
echo "  claude --channels plugin:telegram@atom-plugins"
