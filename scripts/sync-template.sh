#!/usr/bin/env bash
# Sync shared infra (lib/components/api/scripts/env) từ canonical Mushy
# template về mini-app downstream. KHÔNG đụng vào App.jsx, App.css,
# migrations/, mushy.config.json, README.md của app.
#
# Usage:
#   1. Clone Mushy fresh về tạm:
#        git clone https://github.com/anhdqvn/mushy.git /tmp/mushy-latest
#   2. Trong project mini-app downstream, tạo branch:
#        git checkout -b sync-template-$(date +%Y%m%d)
#   3. Chạy:
#        bash scripts/sync-template.sh /tmp/mushy-latest/miniapp-template
#   4. Review:
#        git status; git diff
#   5. Test: npm install && npm run dev:setup && npm run dev
#   6. Push branch → PR vào dev → merge.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <path-to-Mushy/miniapp-template>" >&2
  echo "Vd:   bash scripts/sync-template.sh /tmp/mushy-latest/miniapp-template" >&2
  exit 1
fi

TEMPLATE_DIR="$1"
if [ ! -f "$TEMPLATE_DIR/CLAUDE.md" ]; then
  echo "❌ $TEMPLATE_DIR không phải thư mục miniapp-template (thiếu CLAUDE.md)" >&2
  exit 1
fi

echo "→ Sync from $TEMPLATE_DIR"

# Shared infra paths — sync hoàn toàn (--delete trong rsync sẽ xoá file đã bỏ).
# Lưu ý: src/components KHÔNG sync toàn bộ, chỉ Dialog + Select (rest là app-specific).
declare -a FULL_DIRS=(
  "src/lib"
  "scripts"
)

declare -a SINGLE_FILES=(
  "src/components/Dialog.jsx"
  "src/components/Select.jsx"
  "api/_verify.js"
  ".env.example"
)

# Pre-flight: detect file app-specific trong src/lib/ sẽ bị --delete.
# rsync --delete xoá file ở destination KHÔNG có trong source. Nếu downstream
# để auth.js, chat.js, weather.js, ... (app-specific) trong src/lib/, sẽ
# bị xoá sạch. Print warning + abort nếu phát hiện, user phải:
#   - Move file ra ngoài src/lib/ (vd src/lib/app/, src/app-lib/), HOẶC
#   - Confirm bằng FORCE_DELETE=1 bash scripts/sync-template.sh ...
declare -a EXTRA_FILES
for d in "${FULL_DIRS[@]}"; do
  if [ -d "$TEMPLATE_DIR/$d" ] && [ -d "$d" ]; then
    while IFS= read -r f; do
      rel="${f#$d/}"
      [ "$d" = "scripts" ] && [ "$rel" = "sync-template.sh" ] && continue
      if [ ! -e "$TEMPLATE_DIR/$d/$rel" ]; then
        EXTRA_FILES+=("$f")
      fi
    done < <(find "$d" -type f 2>/dev/null)
  fi
done

if [ ${#EXTRA_FILES[@]} -gt 0 ] && [ -z "${FORCE_DELETE:-}" ]; then
  echo "" >&2
  echo "⚠️  Pre-flight: phát hiện ${#EXTRA_FILES[@]} file app-specific trong shared dirs:" >&2
  for f in "${EXTRA_FILES[@]}"; do echo "     - $f" >&2; done
  echo "" >&2
  echo "rsync --delete sẽ XOÁ các file này. Có 2 lựa chọn:" >&2
  echo "" >&2
  echo "  A) Move chúng ra ngoài src/lib/ (recommended):" >&2
  echo "     mkdir -p src/lib/app  # hoặc src/app-lib/" >&2
  echo "     mv <file> src/lib/app/   # cho mỗi file" >&2
  echo "     Update import path trong App.jsx tương ứng." >&2
  echo "" >&2
  echo "  B) Confirm xoá (mất file vĩnh viễn — chắc chắn đã backup):" >&2
  echo "     FORCE_DELETE=1 bash scripts/sync-template.sh $TEMPLATE_DIR" >&2
  echo "" >&2
  exit 1
fi

# Lib: sync toàn bộ (--delete để bỏ file template đã remove)
for d in "${FULL_DIRS[@]}"; do
  if [ -d "$TEMPLATE_DIR/$d" ]; then
    mkdir -p "$d"
    # KHÔNG sync sync-template.sh chính nó (vòng lặp tự sync mình)
    if [ "$d" = "scripts" ]; then
      rsync -av --exclude='sync-template.sh' "$TEMPLATE_DIR/$d/" "$d/"
    else
      rsync -av --delete "$TEMPLATE_DIR/$d/" "$d/"
    fi
    echo "  ✓ synced $d/"
  fi
done

# Single files
for f in "${SINGLE_FILES[@]}"; do
  if [ -f "$TEMPLATE_DIR/$f" ]; then
    mkdir -p "$(dirname "$f")"
    cp "$TEMPLATE_DIR/$f" "$f"
    echo "  ✓ synced $f"
  fi
done

# Special: CLAUDE.md — copy nhưng cảnh báo (downstream có thể đã custom)
if [ -f "$TEMPLATE_DIR/CLAUDE.md" ]; then
  if ! diff -q "$TEMPLATE_DIR/CLAUDE.md" CLAUDE.md > /dev/null 2>&1; then
    cp "$TEMPLATE_DIR/CLAUDE.md" CLAUDE.md
    echo "  ✓ updated CLAUDE.md (review diff if đã custom)"
  fi
fi

echo ""
echo "✓ Sync xong. Tiếp theo:"
echo "  git status"
echo "  git diff --stat"
echo "  npm install   # nếu package.json đổi (manual review trước!)"
echo "  npm run dev:setup && npm run dev"
echo ""
echo "⚠️  package.json + vite.config.js + vercel.json KHÔNG auto-sync."
echo "    Diff thủ công nếu nghe template có dep mới:"
echo "    diff $TEMPLATE_DIR/package.json package.json"
