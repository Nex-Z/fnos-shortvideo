# 随机短视频（飞牛 fnOS 应用）

飞牛 NAS 上的**抖音式随机短视频浏览应用**。授权 NAS 中的视频目录后，全屏上滑/下滑连续观看随机视频，支持收藏、历史、断点续播。

> 严格遵循飞牛官方开发文档（https://developer.fnnas.com ）的 Native 应用规范：统一网关 + Unix Socket + 包用户权限模型。

## 功能

- ✅ 选择一个或多个视频目录，递归扫描（通过 fnOS 授权目录机制）
- ✅ 全屏单视频播放，上滑下一个随机视频、下滑返回上一条
- ✅ 随机播放避免短时间重复（洗牌队列，整轮后才重排）
- ✅ 自动预加载下一条视频（3 槽轮播，切换无等待）
- ✅ 播放 / 暂停 / 静音 / 进度拖动 / 循环
- ✅ 收藏、历史记录、重新扫描
- ✅ 记录播放位置，退出后继续观看
- ✅ 多用户隔离（基于统一网关注入的 `X-Trim-Userid`）

## 架构

| 层 | 技术 | 说明 |
|---|---|---|
| 后端 | Go 单静态二进制 | 零运行时依赖；交叉编译 linux/amd64 + linux/arm64；原生 HTTP Range 流式输出 |
| 前端 | 原生 HTML/CSS/JS | 抖音风格 3 槽轮播 + 触摸/滚轮/键盘交互，无构建步骤 |
| 存储 | 本地 JSON | 索引与用户态存于 `TRIM_PKGVAR`，重启保留 |
| 访问 | 统一网关 `/app/shortvideo` | 复用 fnOS 登录态，Unix Socket 转发，不暴露独立端口 |

后端二进制由 `cmd/main` 按架构（`uname -m`）选择启动，监听 `${TRIM_APPDEST}/app.sock`，前端静态文件由后端从 `${TRIM_APPDEST}/ui/www` 提供。

## 目录结构

```
short_video_dsy/
├── backend/                Go 后端源码
│   ├── main.go             入口：环境变量、Unix Socket/TCP 双模式
│   ├── server.go           HTTP 路由、网关前缀、静态服务、API
│   ├── scan.go             目录递归扫描、索引构建与持久化
│   ├── state.go            用户态：洗牌队列/收藏/历史/进度
│   ├── stream.go           视频流（HTTP Range + 路径校验）
│   └── util.go             hash/mime/路径工具
├── frontend/               前端源码（原生）
│   ├── index.html
│   ├── app.css
│   └── app.js
├── scripts/
│   ├── build.ps1           Windows 构建脚本
│   ├── build.sh            Linux/macOS 构建脚本
│   └── gen-icons.go        图标生成器
├── shortvideo/             fnpack 应用包目录（appname）
│   ├── app/
│   │   ├── ui/
│   │   │   ├── config      桌面入口（统一网关）
│   │   │   ├── images/     入口图标
│   │   │   └── www/        构建产物：前端
│   │   └── bin/            构建产物：Go 二进制（amd64/arm64）
│   ├── cmd/                生命周期脚本（main/install_*/upgrade_*/...）
│   ├── config/             privilege + resource
│   ├── wizard/             install/upgrade/uninstall/config
│   ├── manifest
│   ├── ICON.PNG / ICON_256.PNG
├── reference/llms-full.txt 官方文档全文（参考资料，不打包）
├── docs/design.md          架构设计文档
└── README.md
```

## 构建

### 前置条件

- Go 1.22+（用于交叉编译后端）
- [可选] fnpack（飞牛打包工具，用于生成 .fpk）

### 一键构建

```powershell
# Windows
pwsh -ExecutionPolicy Bypass -File scripts\build.ps1
```
```bash
# Linux / macOS
bash scripts/build.sh
```

构建产出：
- `shortvideo/app/bin/shortvideo-server-amd64`（linux x86_64 静态二进制）
- `shortvideo/app/bin/shortvideo-server-arm64`（linux aarch64 静态二进制）
- `shortvideo/app/ui/www/`（前端静态文件）

### 生成 .fpk 安装包

安装 [fnpack](https://developer.fnnas.com/docs/cli/fnpack/) 后：

```bash
fnpack build --directory shortvideo
# 产出 shortvideo.fpk
```

## 在飞牛 fnOS 上安装

1. 将 `shortvideo.fpk` 上传到 NAS。
2. 应用中心 → 手动安装 → 选择 fpk 文件 → 安装。
3. 安装完成后，进入**应用设置 → 授权目录**，勾选你要浏览的视频目录（可多选）。
4. 打开应用，自动递归扫描，开始上滑浏览。

> 也可用 `appcenter-cli install-fpk shortvideo.fpk` 命令行安装。

## 本地开发调试

无需 fnOS，直接用 TCP 模式启动后端：

```bash
cd backend
go run . -port 8080 -www ../frontend -data ./data -roots "/path/to/videos"
# 浏览器打开 http://localhost:8080/app/shortvideo/
```

参数：
- `-port` TCP 端口（生产用 `SOCKET_PATH` 环境变量走 Unix Socket）
- `-www` 前端目录
- `-data` 数据目录（索引与用户态）
- `-roots` 扫描根目录，多个用 `;` 分隔
- `-prefix` 网关前缀，默认 `/app/shortvideo`

## 使用说明

| 操作 | 效果 |
|---|---|
| 上滑 / ↓ 键 / 滚轮下 | 下一个随机视频 |
| 下滑 / ↑ 键 / 滚轮上 | 返回上一个 |
| 单击视频 | 暂停 / 播放 |
| 双击视频 | 收藏 / 取消收藏 |
| `f` 键 | 收藏切换 |
| `m` 键 | 静音切换 |
| 空格 | 暂停 / 播放 |
| 右侧栏 | 收藏 / 历史 / 设置 / 重扫 |
| 底部进度条 | 拖动跳转 |

> 首次打开因浏览器自动播放策略，视频会以静音播放，点击视频即可开启声音。

## API 一览（统一网关前缀 /app/shortvideo）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/config` | 授权目录、视频数、扫描状态 |
| POST | `/api/rescan` | 触发重扫 |
| GET | `/api/session` | 当前视频 + 邻居 ID（预加载） |
| POST | `/api/session/next` | 上滑：前进 |
| POST | `/api/session/prev` | 下滑：后退 |
| POST | `/api/session/jump` | 跳转到指定 ID |
| GET | `/api/video/{id}` | 视频元信息 + 进度 |
| GET | `/api/stream/{id}` | 视频流（HTTP Range） |
| GET | `/api/state` | 收藏 / 历史 / 进度 |
| POST | `/api/favorite` | 切换收藏 |
| POST | `/api/progress` | 保存播放进度 |

## 安全

- 视频流按 **ID**（路径 SHA1）取文件，服务端校验路径必须在 `TRIM_DATA_ACCESSIBLE_PATHS` 授权目录内，防目录穿越。
- 用户身份取自网关 `X-Trim-Userid` Header，不信任客户端传入的 uid；数据按用户隔离。
- 应用以专用包用户 `shortvideo` 运行（`run-as=package`），最小权限。

## 上架说明

当前为自用版本。上架前需：
- 补全 `manifest` 的 `maintainer_url`、`distributor` 等字段
- 在真实 fnOS 设备上完成安装/启停/多用户/边界场景测试
- 准备应用截图与描述
- 通过飞牛应用中心开发者流程提交（目前经社区先锋交流群联系主理人）

## 许可

自用，未声明开源许可。
