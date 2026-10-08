#!/usr/bin/env bash
# Installs or updates simmer on this machine and points the cook skills at it.
# Fresh machine: curl -fsSL https://raw.githubusercontent.com/Yiin/simmer/main/scripts/install.sh | bash
set -euo pipefail
repo="$HOME/Projects/simmer"
if [ -d "$repo/.git" ]; then git -C "$repo" pull --ff-only -q
else git clone -q https://github.com/Yiin/simmer.git "$repo"; fi
bun="$(command -v bun || echo "$HOME/.bun/bin/bun")"
[ -x "$bun" ] || { echo "simmer needs bun: https://bun.sh" >&2; exit 1; }
( cd "$repo" && "$bun" install --frozen-lockfile >/dev/null )
mkdir -p "$HOME/.local/bin"
printf '#!/usr/bin/env bash\nexec "%s" "%s/src/cli.ts" "$@"\n' "$bun" "$repo" > "$HOME/.local/bin/simmer"
chmod +x "$HOME/.local/bin/simmer"
for dir in "$HOME/.agents/skills" "$HOME/.claude/skills"; do
  mkdir -p "$dir"
  for skill in cook-it cook-epic; do
    link="${dir:?}/${skill:?}"
    # A copied skill folder would swallow the link. Keep it beside, under a dated name.
    if [ -d "$link" ] && [ ! -L "$link" ]; then mv -f "$link" "$link.bak-$(date +%Y%m%d%H%M%S)"; fi
    ln -sfn "$repo/skills/$skill" "$link"
  done
done
echo "$(hostname): simmer $(git -C "$repo" rev-parse --short HEAD), skills -> $(readlink "$HOME/.claude/skills/cook-epic")"
