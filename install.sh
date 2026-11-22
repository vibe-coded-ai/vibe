#!/bin/sh
# vibe-coded.ai CLI skill installer
#
# Usage:  curl -fsSL https://vibe-coded.ai/install.sh | sh
#
# Installs the skill to ~/.claude/skills/vibe-coded-ai, links the `vibe`
# binary into ~/.local/bin (or ~/bin), never a package manager's prefix, and links the skill at ~/.agents/skills/vibe-coded-ai
# (the cross-vendor Agent Skills path read by Codex, Gemini, Cursor, Amp and
# opencode). Override locations with CLAUDE_SKILLS_DIR, VIBE_BIN_DIR and
# VIBE_AGENTS_SKILLS_DIR. Safe to re-run: an existing install is moved aside,
# not deleted.
set -eu

ZIP_URL="https://vibe-coded.ai/vibe-coded-ai-skill.zip"
SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
# Link `vibe` into a bin dir in your home folder: ~/.local/bin when it's on
# PATH, else ~/bin when it's on PATH, else ~/.local/bin with a PATH note at the
# end. Never a package manager's prefix (/opt/homebrew/bin, /usr/local/bin):
# we aren't installed through one, and a stray link there looks like one.
on_path() { case ":$PATH:" in *:"$1":*) return 0 ;; esac; return 1; }
if [ -n "${VIBE_BIN_DIR:-}" ]; then
  BIN_DIR="$VIBE_BIN_DIR"
elif on_path "$HOME/.local/bin"; then
  BIN_DIR="$HOME/.local/bin"
elif on_path "$HOME/bin" && [ -d "$HOME/bin" ] && [ -w "$HOME/bin" ]; then
  BIN_DIR="$HOME/bin"
else
  BIN_DIR="$HOME/.local/bin"
fi
AGENTS_SKILLS_DIR="${VIBE_AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
DEST="$SKILLS_DIR/vibe-coded-ai"
AGENTS_LINK="$AGENTS_SKILLS_DIR/vibe-coded-ai"

for cmd in curl unzip bash jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: $cmd is required" >&2
    [ "$cmd" = jq ] && echo "  macOS: brew install jq    Debian/Ubuntu: sudo apt install jq" >&2
    exit 1
  fi
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

echo "Downloading skill from $ZIP_URL ..."
curl -fsSL "$ZIP_URL" -o "$TMP/skill.zip"
unzip -q "$TMP/skill.zip" -d "$TMP/extract"
[ -f "$TMP/extract/vibe-coded-ai/SKILL.md" ] || { echo "error: unexpected archive layout" >&2; exit 1; }

mkdir -p "$SKILLS_DIR"
# Backups live OUTSIDE the skills folder: coding agents load every folder in
# ~/.claude/skills as a skill, so a backup kept there shows up as a second,
# stale "vibe-coded-ai" skill. Earlier installers did exactly that; sweep any
# such leftovers out of the load path too.
BACKUP_DIR="${VIBE_BACKUP_DIR:-$HOME/.vibe-coded/skill-backups}"
STAMP="$(date +%Y%m%d%H%M%S)"
for old in "$DEST".bak.*; do
  [ -e "$old" ] || continue
  mkdir -p "$BACKUP_DIR"
  mv "$old" "$BACKUP_DIR/$(basename "$old")"
  echo "Moved an old backup out of the skills folder: $BACKUP_DIR/$(basename "$old")"
done
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  mkdir -p "$BACKUP_DIR"
  BACKUP="$BACKUP_DIR/vibe-coded-ai.$STAMP"
  [ -e "$BACKUP" ] && BACKUP="$BACKUP.$$"   # two installs in one second must not nest
  echo "Existing install found — moving it to $BACKUP"
  mv "$DEST" "$BACKUP"
fi
mv "$TMP/extract/vibe-coded-ai" "$DEST"

mkdir -p "$BIN_DIR"
chmod +x "$DEST/bin/vibe"
# Never replace someone else's `vibe`: only (re)link when the slot is empty or
# already holds a link to a vibe-coded-ai skill.
LINKED=1
if [ -e "$BIN_DIR/vibe" ] || [ -L "$BIN_DIR/vibe" ]; then
  case "$(readlink "$BIN_DIR/vibe" 2>/dev/null)" in
    */vibe-coded-ai/bin/vibe) ;;
    *) LINKED=0 ;;
  esac
fi
if [ "$LINKED" = 1 ]; then
  ln -sf "$DEST/bin/vibe" "$BIN_DIR/vibe"
fi

# Cross-vendor Agent Skills path (Codex, Gemini, Cursor, Amp, opencode).
if [ "$AGENTS_LINK" != "$DEST" ]; then
  mkdir -p "$AGENTS_SKILLS_DIR"
  ln -sfn "$DEST" "$AGENTS_LINK"
fi

echo ""
echo "Installed: $DEST"
if [ "$LINKED" = 1 ]; then
  echo "Linked:    $BIN_DIR/vibe"
else
  echo "Skipped:   $BIN_DIR/vibe is a different program called 'vibe'; left it alone."
fi
if [ "$AGENTS_LINK" != "$DEST" ]; then
  echo "Linked:    $AGENTS_LINK"
fi
# Signed in = a credentials file with a token whose expiresAt is still ahead.
# An expired, empty, or malformed file still gets the login hint.
signed_in() {
  # jq is a checked prerequisite above; a malformed file is not a sign-in.
  jq -e --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '(.token | type == "string" and length > 0) and (.expiresAt | type == "string" and . > $now)' \
    "$HOME/.vibe-coded/credentials.json" >/dev/null 2>&1
}
echo ""
if [ "$LINKED" = 0 ]; then
  if ! signed_in; then
    echo "Next:  $DEST/bin/vibe login   (opens your browser to sign in — or ask your coding agent to log in)"
  fi
elif on_path "$BIN_DIR"; then
  if ! signed_in; then
    echo "Next:  vibe login   (opens your browser to sign in — or ask your coding agent to log in)"
  fi
else
  # Print one copy-paste command that adds BIN_DIR to PATH for this shell and
  # future ones. We never edit shell profiles ourselves.
  case "$BIN_DIR" in
    "$HOME"/*) PATH_DIR="\$HOME${BIN_DIR#"$HOME"}" ;;
    *) PATH_DIR="$BIN_DIR" ;;
  esac
  EXPORT_LINE="export PATH=\"$PATH_DIR:\$PATH\""
  SHELL_NAME="$(basename "${SHELL:-}")"
  # A custom VIBE_BIN_DIR with quotes, $ or backslashes can't be pasted safely
  # into a quoted command; fall back to the full-path login for those.
  case "$BIN_DIR" in *[\'\"\$\\\`]*) SHELL_NAME="unsafe-path" ;; esac
  case "$SHELL_NAME" in
    zsh)  PATH_CMD="echo '$EXPORT_LINE' >> ~/.zshrc && source ~/.zshrc" ;;
    bash)
      if [ "$(uname -s)" = Darwin ]; then RC="~/.bash_profile"; else RC="~/.bashrc"; fi
      PATH_CMD="echo '$EXPORT_LINE' >> $RC && source $RC" ;;
    fish) PATH_CMD="fish_add_path $BIN_DIR" ;;
    *)    PATH_CMD="" ;;
  esac
  echo "$BIN_DIR is not on your PATH yet."
  if [ -n "$PATH_CMD" ]; then
    echo "Add it (paste this once):"
    echo "  $PATH_CMD"
  elif [ "$SHELL_NAME" = unsafe-path ]; then
    echo "Add $BIN_DIR to PATH in your shell profile, then open a new terminal."
  else
    echo "Add this line to your shell profile, then open a new terminal:"
    echo "  $EXPORT_LINE"
  fi
  echo ""
  if ! signed_in; then
    echo "Next:  vibe login"
    echo "  (or, without changing PATH: $BIN_DIR/vibe login)"
  fi
fi
echo "Docs:  https://vibe-coded.ai/docs/cli"
