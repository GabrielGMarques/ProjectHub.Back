#!/bin/bash
# empinfo — Query employee data from the Obsidian Alfred vault
#
# Usage:
#   ./empinfo.sh <employee-id-or-name>           # auto-detect project
#   ./empinfo.sh <employee-id-or-name> <project> # explicit project
#   ./empinfo.sh 10339f
#   ./empinfo.sh "Full Stack Developer - 10339f"
#   ./empinfo.sh 10339f Influencer
#
# Requires:
#   - Obsidian app running with CLI enabled (Settings → General → CLI)
#   - Vault: D:\GrowthMaster\Repos\Alfred\Alfred

VAULT="D:/GrowthMaster/Repos/Alfred/Alfred/ProjectsHub"

if [ -z "$1" ]; then
  echo "Usage: $0 <employee-id-or-name> [project]"
  echo ""
  echo "Examples:"
  echo "  $0 10339f"
  echo "  $0 \"Full Stack Developer - 10339f\""
  echo "  $0 10339f Influencer"
  exit 1
fi

QUERY="$1"
PROJECT_FILTER="$2"

# Step 1: Find the employee file on disk to discover the project + full filename
if [ -n "$PROJECT_FILTER" ]; then
  EMP_FILE=$(find "$VAULT/$PROJECT_FILTER/employees" -maxdepth 1 -name "*${QUERY}*.md" 2>/dev/null | head -1)
else
  EMP_FILE=$(find "$VAULT" -path "*/employees/*${QUERY}*.md" 2>/dev/null | head -1)
fi

if [ -z "$EMP_FILE" ]; then
  echo "❌ Employee not found matching: $QUERY"
  echo ""
  echo "Available employees:"
  find "$VAULT" -path "*/employees/*.md" 2>/dev/null | sed "s|$VAULT/||;s|/employees/| → |;s|\.md$||" | sort
  exit 1
fi

EMP_NAME=$(basename "$EMP_FILE" .md)
PROJECT=$(echo "$EMP_FILE" | sed "s|$VAULT/||" | cut -d/ -f1)
LEARNINGS_NAME="$EMP_NAME - learnings"
PROJECT_FILE="_project - $PROJECT"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║ 👤 Employee:  $EMP_NAME"
echo "║ 📁 Project:   $PROJECT"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Capture all output so we can count chars/tokens at the end
OUTPUT=$(
  echo "═══════════════ 📋 EMPLOYEE PROFILE ═══════════════"
  obsidian read file="$EMP_NAME"

  echo ""
  echo "═══════════════ 📘 LEARNINGS ═══════════════"
  obsidian read file="$LEARNINGS_NAME" 2>/dev/null || echo "(no learnings file)"

  echo ""
  echo "═══════════════ 🏢 PROJECT & TEAM ═══════════════"
  obsidian read file="$PROJECT_FILE"

  echo ""
  echo "═══════════════ 🔗 BACKLINKS ═══════════════"
  obsidian backlinks file="$EMP_NAME" 2>/dev/null || echo "(no backlinks)"
)

echo "$OUTPUT"

# Count characters and estimate tokens (rough: 1 token ≈ 4 chars for English text)
CHARS=$(echo -n "$OUTPUT" | wc -c)
WORDS=$(echo -n "$OUTPUT" | wc -w)
TOKENS=$((CHARS / 4))

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║ 📊 STATS"
echo "║ Characters:      $CHARS"
echo "║ Words:           $WORDS"
echo "║ Estimated tokens: ~$TOKENS  (chars/4)"
echo "╚════════════════════════════════════════════════════════════╝"
