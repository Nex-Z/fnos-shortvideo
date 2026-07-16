#!/bin/bash
# 飞牛随机短视频 - 构建脚本（Linux/macOS）
# 产出：shortvideo/app/bin/shortvideo-server-amd64 与 shortvideo/app/ui/www/
# 注意：manifest platform=x86，仅编译 amd64。如需 ARM，改 platform=arm 并编译 arm64。
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
backend="$root/backend"
pkg="$root/shortvideo"
binDir="$pkg/app/bin"
wwwDir="$pkg/app/ui/www"

echo "==> 编译 Go 后端（linux/amd64，platform=x86）"
cd "$backend"
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$binDir/shortvideo-server-amd64" .
echo "  -> linux/amd64 : $binDir/shortvideo-server-amd64"

echo "==> 拷贝前端到 $wwwDir"
rm -rf "$wwwDir"
mkdir -p "$wwwDir"
cp -r "$root/frontend/"* "$wwwDir/"

# 确保 wizard 目录存在且为空（应用走授权目录机制，不需要向导；
# 飞牛校验不允许只有 tips 的 step，故 wizard 留空目录）
mkdir -p "$pkg/wizard"

# 确保执行位（Windows 打包可能丢失）
chmod +x "$binDir"/shortvideo-server-* 2>/dev/null || true
chmod +x "$pkg"/cmd/* 2>/dev/null || true

echo "==> 完成。包目录：$pkg"
ls -la "$binDir"
echo "前端文件数: $(find "$wwwDir" -type f | wc -l)"
echo ""
echo "下一步：安装 fnpack 后运行  fnpack build --directory $pkg  生成 .fpk"
