#!/usr/bin/env bash
# Installs or updates simmer on this machine and points the cook skills at it.
set -euo pipefail
repo="$HOME/Projects/simmer"
if [ -d "$repo/.git" ]; then git -C "$repo" pull --ff-only -q
else git clone -q git@github.com:Yiin/simmer.git "$repo"; fi
( cd "$repo" && "$HOME/.bun/bin/bun" install --frozen-lockfile >/dev/null )
mkdir -p "$HOME/.local/bin"
printf '#!/usr/bin/env bash\nexec "$HOME/.bun/bin/bun" "$HOME/Projects/simmer/src/cli.ts" "$@"\n' > "$HOME/.local/bin/simmer"
chmod +x "$HOME/.local/bin/simmer"
for dir in "$HOME/.agents/skills" "$HOME/.claude/skills"; do
  for skill in cook-it cook-epic; do
    ln -sfn "$repo/skills/$skill" "${dir:?}/${skill:?}"
  done
done
echo "$(hostname): simmer $(git -C "$repo" rev-parse --short HEAD), skills -> $(readlink "$HOME/.claude/skills/cook-epic")"
