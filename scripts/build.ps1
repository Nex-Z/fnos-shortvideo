# 飞牛随机短视频 - 构建脚本（Windows PowerShell）
# 产出：shortvideo/app/bin/shortvideo-server-amd64 与 shortvideo/app/ui/www/
# 注意：manifest platform=x86，仅编译 amd64。如需 ARM，改 platform=arm 并编译 arm64。
# 之后用 fnpack build --directory shortvideo 生成 .fpk

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root "backend"
$pkg = Join-Path $root "shortvideo"
$binDir = Join-Path $pkg "app\bin"
$wwwDir = Join-Path $pkg "app\ui\www"

Write-Host "==> 编译 Go 后端（linux/amd64，platform=x86）"
Push-Location $backend
try {
  $env:GOOS = "linux"; $env:GOARCH = "amd64"; $env:CGO_ENABLED = "0"
  $dest = Join-Path $binDir "shortvideo-server-amd64"
  Write-Host "  -> linux/amd64 : $dest"
  & go build -trimpath -ldflags "-s -w" -o $dest .
  if ($LASTEXITCODE -ne 0) { throw "编译失败: linux/amd64" }
} finally {
  $env:GOOS = ""; $env:GOARCH = ""; $env:CGO_ENABLED = ""
  Pop-Location
}

Write-Host "==> 拷贝前端到 $wwwDir"
if (Test-Path $wwwDir) { Remove-Item -Recurse -Force $wwwDir }
New-Item -ItemType Directory -Force -Path $wwwDir | Out-Null
Copy-Item -Path (Join-Path $root "frontend\*") -Destination $wwwDir -Recurse -Force

# 确保 wizard 目录存在且为空（应用走授权目录机制，不需要向导；
# 飞牛校验不允许只有 tips 的 step，故 wizard 留空目录）
$wizardDir = Join-Path $pkg "wizard"
New-Item -ItemType Directory -Force -Path $wizardDir | Out-Null

Write-Host "==> 完成。包目录：$pkg"
Write-Host "    可执行："
Get-ChildItem $binDir | ForEach-Object { Write-Host "      $($_.Name)  ($([math]::Round($_.Length/1MB,2)) MB)" }
Write-Host "    前端文件：$((Get-ChildItem $wwwDir -Recurse -File).Count) 个"
Write-Host ""
Write-Host "下一步：安装 fnpack 后运行  fnpack build --directory `"$pkg`"  生成 .fpk"
