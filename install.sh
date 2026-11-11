#!/usr/bin/env bash
# 把 dsh-tingfeng 装进 DSH profile。
#
# 为什么不用 `npm install`：profile 里有别的包用了 `workspace:*`，
# 完整安装会报 EUNSUPPORTEDPROTOCOL 整单失败。做法是解包 + 手建软链。
#
# 为什么必须建软链（2026-11-08 踩过）：
#   tgz 里只有 plugins/ 下的 18 个子包实体，**没有** node_modules/。
#   那个目录原本是 pnpm 装的，里面是 18 条
#       node_modules/<子包名> -> ../plugins/<子包名>
#   的软链。手动 `rm -rf` 插件目录再解包时，这个目录不会自动回来，
#   于是宿主启动时报 11 个
#       failed to import: ERR_MODULE_NOT_FOUND: Cannot find package 'dsh-tingfeng-source-*'
#   而且**插件不报错、只是静默地什么都不注入**——热记忆快照、冷库提醒
#   全部消失，界面上看不出任何异常。这条脚本把这一步固化下来。
#
# 用法： ./install.sh <tgz 路径> [profile 名，默认 web]

set -euo pipefail

TGZ="${1:?用法: $0 <tgz 路径> [profile 名]}"
PROFILE="${2:-web}"
ROOT="$HOME/.dsh/profiles/$PROFILE"
DEST="$ROOT/node_modules/dsh-tingfeng"

[ -f "$TGZ" ] || { echo "找不到 $TGZ" >&2; exit 1; }
[ -d "$ROOT" ] || { echo "找不到 profile 目录 $ROOT" >&2; exit 1; }

# 统一把 tgz 放到 ~/dsh-packs（与既有约定一致），再从那里引用
PACKS="$HOME/dsh-packs"
mkdir -p "$PACKS"
# 源文件已经在这个目录里时 cp 会拒绝自己拷自己（即使 -f），所以先比路径
case "$TGZ" in
  "$PACKS"/*) ;;
  *) cp -f "$TGZ" "$PACKS/" ;;
esac
TGZ="$PACKS/$(basename "$TGZ")"

VERSION=$(python3 -c "import tarfile,json,sys;print(json.load(tarfile.open(sys.argv[1]).extractfile('package/package.json'))['version'])" "$TGZ")
echo "安装 dsh-tingfeng $VERSION → $DEST"

# 备份现有安装（有的话）
if [ -d "$DEST" ]; then
  BACKUP="$HOME/.mnemon/__backup__/tingfeng_install_$(date +%Y%m%d_%H%M%S)"
  mkdir -p "$BACKUP"
  cp -a "$DEST" "$BACKUP/"
  echo "  已备份到 $BACKUP"
fi

rm -rf "$DEST"
mkdir -p "$DEST"
tar xzf "$TGZ" -C "$DEST" --strip-components=1

# 关键步骤：重建子包软链
mkdir -p "$DEST/node_modules"
LINKED=0
for dir in "$DEST"/plugins/*/; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir")
  ln -sfn "../plugins/$name" "$DEST/node_modules/$name"
  LINKED=$((LINKED + 1))
done
echo "  已建 $LINKED 条子包软链"

# 验证：从包内解析每个子包
echo "  验证解析："
FAIL=0
for dir in "$DEST"/plugins/*/; do
  name=$(basename "$dir")
  if [ ! -e "$DEST/node_modules/$name/package.json" ]; then
    echo "    ❌ $name"
    FAIL=$((FAIL + 1))
  fi
done
if [ "$FAIL" -gt 0 ]; then
  echo "有 $FAIL 个子包解析不了，安装不完整" >&2
  exit 1
fi
echo "    ✅ 全部 $LINKED 个子包可解析"

# 更新 profile 依赖指向
python3 - "$ROOT/package.json" "$TGZ" <<'PY'
import io, json, sys, os
path, tgz = sys.argv[1], sys.argv[2]
profile = os.path.dirname(path)
rel = os.path.relpath(os.path.dirname(os.path.abspath(tgz)), profile)
doc = json.load(io.open(path, encoding='utf-8'))
doc.setdefault('dependencies', {})['dsh-tingfeng'] = 'file:' + rel + '/' + os.path.basename(tgz)
bundles = doc.get('dsh', {}).get('profile', {}).get('bundles')
if bundles is not None and 'dsh-tingfeng' not in bundles:
    bundles.append('dsh-tingfeng')
io.open(path, 'w', encoding='utf-8').write(json.dumps(doc, indent=2, ensure_ascii=False) + '\n')
print('  依赖已指向', doc['dependencies']['dsh-tingfeng'])
PY

echo
echo "完成。重启 DSH 后生效。"
echo "重启后在 host.log 里搜 'failed to import' —— 应为 0 条："
echo "  grep -c 'failed to import' ~/.local/state/dsh-web/host.log"
