#!/usr/bin/env bash
# 開発コンテナで headless Chromium を動かすための準備。
#
# このコンテナには root 権限が無く apt が使えないため、Chromium の実行に必要な
# 共有ライブラリとフォントを Debian の公式インデックスから直接取得して
# /tmp/chromedeps 配下に展開する。/tmp は揮発するので、コンテナを作り直したら
# このスクリプトを再実行すること。
#
#   bash dev/setup-container.sh && npm test
#
# 冪等: 既に展開済みなら何もしない。
set -euo pipefail

DEPS_ROOT=/tmp/chromedeps
WORK=/tmp/deb
SUITE=bookworm

if [ -f "$DEPS_ROOT/etc/fonts/fonts.conf" ] && [ -f "$DEPS_ROOT/usr/lib/x86_64-linux-gnu/libglib-2.0.so.0" ]; then
  echo "既に準備済み: $DEPS_ROOT"
  exit 0
fi

mkdir -p "$WORK" "$DEPS_ROOT"

if [ ! -f "$WORK/Packages.gz" ]; then
  echo "Debian パッケージインデックスを取得中..."
  curl -sS -o "$WORK/Packages.gz" \
    "http://deb.debian.org/debian/dists/$SUITE/main/binary-amd64/Packages.gz"
fi

echo "依存パッケージを解決・展開中..."
python3 - "$WORK" "$DEPS_ROOT" <<'PY'
import re, os, sys, gzip, urllib.request, subprocess

work, deps_root = sys.argv[1], sys.argv[2]
data = gzip.open(os.path.join(work, 'Packages.gz'), 'rt', encoding='utf-8', errors='replace').read()

pkgs = {}
for block in data.split('\n\n'):
    m = re.search(r'^Package: (\S+)', block, re.M)
    f = re.search(r'^Filename: (\S+)', block, re.M)
    d = re.search(r'^Depends: (.+)$', block, re.M)
    if m and f and m.group(1) not in pkgs:
        pkgs[m.group(1)] = (f.group(1), d.group(1) if d else '')

want = """libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0
libcups2 libdbus-1-3 libdrm2 libgbm1 libxkbcommon0 libx11-6 libxcb1 libxcomposite1
libxdamage1 libxext6 libxfixes3 libxrandr2 libasound2 libcairo2 libpango-1.0-0
libexpat1 libxshmfence1 libwayland-client0 libwayland-server0 libxau6 libxdmcp6
libxi6 libxtst6 libxcursor1 fonts-dejavu-core fonts-ipafont-gothic""".split()

seen, order, stack = set(), [], list(want)
while stack:
    p = stack.pop()
    if p in seen or p not in pkgs:
        continue
    seen.add(p); order.append(p)
    for alt in pkgs[p][1].split(','):
        n = alt.split('|')[0].strip().split(' ')[0]
        if n in pkgs and n not in seen:
            stack.append(n)

print(f'  {len(order)} パッケージ')
for p in order:
    fn = pkgs[p][0]
    out = os.path.join(work, os.path.basename(fn))
    if not os.path.exists(out):
        urllib.request.urlretrieve('http://deb.debian.org/debian/' + fn, out)
    subprocess.run(['dpkg-deb', '-x', out, deps_root], check=False)
PY

# Chromium はフォントが1つも見つからないと起動直後にクラッシュするため、
# 展開したフォントを指す fontconfig 設定を用意する。
echo "fontconfig を設定中..."
mkdir -p "$DEPS_ROOT/etc/fonts" "$DEPS_ROOT/fontcache"
cat > "$DEPS_ROOT/etc/fonts/fonts.conf" <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>$DEPS_ROOT/usr/share/fonts</dir>
  <cachedir>$DEPS_ROOT/fontcache</cachedir>
  <match target="pattern"><test qual="any" name="family"><string>sans-serif</string></test>
    <edit name="family" mode="prepend" binding="strong"><string>DejaVu Sans</string><string>IPAGothic</string></edit></match>
  <match target="pattern"><test qual="any" name="family"><string>sans</string></test>
    <edit name="family" mode="prepend" binding="strong"><string>DejaVu Sans</string><string>IPAGothic</string></edit></match>
  <match target="pattern"><test qual="any" name="family"><string>monospace</string></test>
    <edit name="family" mode="prepend" binding="strong"><string>DejaVu Sans Mono</string></edit></match>
</fontconfig>
EOF

echo "完了: $DEPS_ROOT"
echo "  npm test で E2E テストを実行できます。"
