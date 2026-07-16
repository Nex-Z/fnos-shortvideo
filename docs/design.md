# 飞牛随机短视频应用 - 架构设计

> 遵循飞牛 fnOS 官方开发文档（https://developer.fnnas.com ），参考 Native 应用案例 `notepad`。
> PRD：抖音风格本地随机短视频浏览。自用为主，结构规范可上架。

## 1. 应用定位

- **appname**：`shortvideo`
- **display_name**：随机短视频
- **访问方式**：统一网关 `/app/shortvideo`（复用 fnOS 登录态，不暴露独立端口）
- **网关 Socket**：`${TRIM_APPDEST}/app.sock`
- **架构类型**：Native 应用（常驻服务 + Web UI），非 Docker
- **平台**：`all`（按架构选择 Go 二进制：amd64 / arm64）

## 2. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 后端 | **Go 单静态二进制** | 零运行时依赖（无需 `nodejs_v22`）；Windows 交叉编译 linux/amd64+arm64；原生 HTTP Range（`http.ServeContent`）；高效目录遍历；契合 manifest `platform=all` 按架构放二进制 |
| 前端 | **原生 HTML/CSS/JS**（无构建） | 抖音单列全屏滑动无需 React 复杂度；无构建步骤，打包即拷贝静态文件；体积小加载快 |
| 存储 | **本地 JSON**（`TRIM_PKGVAR`） | PRD 要求内存索引或本地 JSON，不引入数据库；重启保留 |

## 3. 目录结构（仓库根 = 开发工作区）

参考官方 notepad 案例：开发源码与打包目录分离，`fnpack build --directory shortvideo`。

```
short_video_dsy/                    仓库根（开发工作区）
├── reference/llms-full.txt         官方文档全文（不打包）
├── docs/design.md                  本设计文档
├── backend/                        Go 源码
│   ├── go.mod
│   ├── main.go                     入口：读环境变量、启服务
│   ├── server.go                   HTTP 路由、网关前缀、静态服务
│   ├── scan.go                     目录递归扫描、索引构建
│   ├── queue.go                    洗牌队列、next/prev 去重逻辑
│   ├── state.go                    用户态：收藏/历史/进度
│   ├── stream.go                   视频流输出（HTTP Range、路径校验）
│   └── util.go                     辅助：hash、mime、视频扩展名
├── frontend/                       前端源码（原生）
│   ├── index.html
│   ├── app.css
│   ├── app.js
│   └── assets/
├── scripts/
│   ├── build.ps1                   Windows 构建脚本
│   └── build.sh                    Linux/macOS 构建脚本
├── shortvideo/                     <<< fnpack 应用包目录（appname）
│   ├── app/
│   │   ├── ui/
│   │   │   ├── config              桌面入口注册（统一网关）
│   │   │   ├── images/             入口图标 icon_64.png / icon_256.png
│   │   │   └── www/                构建产物：前端静态文件
│   │   └── bin/                    构建产物：shortvideo-server-amd64 / -arm64
│   ├── cmd/                        生命周期脚本（bash）
│   │   ├── main                    start/stop/status
│   │   ├── install_init / install_callback
│   │   ├── upgrade_init / upgrade_callback
│   │   ├── uninstall_init / uninstall_callback
│   │   └── config_init / config_callback
│   ├── config/
│   │   ├── privilege               run-as=package
│   │   └── resource                data-share（应用数据目录）
│   ├── wizard/                     install/upgrade/uninstall/config
│   ├── manifest                    key=value
│   ├── ICON.PNG                    64x64
│   └── ICON_256.PNG                256x256
├── README.md
└── .gitignore
```

## 4. manifest（shortvideo/manifest）

```ini
appname=shortvideo
version=0.1.0
display_name=随机短视频
desc=飞牛 NAS 上的抖音式随机短视频浏览应用。选择视频目录后，上滑切换随机视频。
source=thirdparty
platform=all
maintainer=dsy
maintainer_url=
os_min_version=1.1.3100
desktop_uidir=ui
desktop_applaunchname=shortvideo.main
ctl_stop=true
checkport=false
disable_authorization_path=false
changelog=首版：随机短视频浏览、上滑切换、收藏、历史、断点续播。
```

要点：
- `os_min_version=1.1.3100`：统一网关要求（国内版）。
- 不声明 `service_port`：统一网关走 Socket，不需要端口。
- `disable_authorization_path=false`（默认）：用户在应用设置授权视频目录 → 应用读 `TRIM_DATA_ACCESSIBLE_PATHS`。
- `ctl_stop=true`：显示启停，常驻服务。

## 5. 权限与资源

**config/privilege**：
```json
{
  "defaults": { "run-as": "package" },
  "username": "shortvideo",
  "groupname": "shortvideo"
}
```
- 以专用包用户运行，最小权限。
- 不加 `join-groups`：v1 无转码/硬件加速，仅读授权目录文件。

**config/resource**：
```json
{
  "data-share": {
    "shares": [
      { "name": "shortvideo/data" }
    ]
  }
}
```
- 应用自用数据目录（索引、用户态 JSON），通过 `TRIM_DATA_SHARE_PATHS` 或 `/var/apps/shortvideo/share/data` 软链访问。
- 注：状态文件主要放 `TRIM_PKGVAR`（重启保留，应用私有）；data-share 备用。

## 6. 视频文件访问机制

1. 用户安装后，在 fnOS 应用设置中为应用**授权视频目录**（`disable_authorization_path=false` 提供）。
2. 应用启动读 `TRIM_DATA_ACCESSIBLE_PATHS`（`:` 分隔）= 授权目录列表。
3. Go 服务递归扫描这些目录下的视频文件（mp4/mkv/mov/avi/webm/ts/m4v/flv/wmv/3gp/mpg/mpeg 等）。
4. 视频流端点按 **ID** 取文件（ID = 路径 SHA1），服务端校验路径必须在授权目录内，防穿越。
5. `http.ServeContent` 原生支持 Range，浏览器拖动进度条正常。

## 7. 索引与随机队列

**索引**（`TRIM_PKGVAR/index.json`，共享）：
```json
{
  "scannedAt": "2026-07-15T15:00:00Z",
  "roots": ["/vol1/Users/admin/Videos"],
  "videos": [
    { "id": "a1b2...", "path": "/vol1/.../x.mp4", "name": "x.mp4", "size": 123456, "mtime": 1700000000 }
  ]
}
```
- 后台启动时若索引缺失或过期则扫描；`POST /api/rescan` 手动触发。
- ID = SHA1(绝对路径) 前 16 hex，跨重扫稳定（收藏/进度持久）。

**随机队列**（每用户 `TRIM_PKGVAR/users/{uid}.json`）：
```json
{
  "deck": ["id1","id2",...],     // 洗牌后的播放序列
  "cursor": 3,                    // 当前在 deck 中的位置
  "favorites": ["idA","idB"],
  "history": [{"id":"id1","ts":170...}],  // 最近播放，最新在前，上限 200
  "progress": { "id1": { "pos": 12.5, "dur": 60, "ts":170... } },
  "last": { "id": "id1", "pos": 12.5 }
}
```
- 首次使用：从索引生成洗牌 deck。
- 上滑 next：cursor++；到末尾则重新洗牌（新 deck 首项 ≠ 当前项），避免短时重复。
- 下滑 prev：cursor--；到开头不动。
- 跳转（历史/收藏）：定位到 deck 中该 ID 位置并设为 cursor；不存在则插到当前位置后。
- 重扫后对账：deck 移除已删除 ID，追加新增 ID。

## 8. API 设计（统一网关前缀 /app/shortvideo）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/config` | 配置：授权目录、视频数、扫描状态 |
| POST | `/api/rescan` | 触发重扫 |
| GET | `/api/session` | 当前会话：当前视频、上/下一个 ID、cursor、总数 |
| POST | `/api/session/next` | 上滑：前进，返回新当前视频 |
| POST | `/api/session/prev` | 下滑：后退 |
| POST | `/api/session/jump` | 跳转到指定 ID（历史/收藏） |
| GET | `/api/video/{id}` | 视频元信息 |
| GET | `/api/stream/{id}` | 视频流（Range） |
| GET | `/api/state` | 收藏、历史、进度、last |
| POST | `/api/favorite` | `{id,favorite}` 切换收藏 |
| POST | `/api/progress` | `{id,pos,dur}` 保存播放进度 |
| GET | `/api/health` | 健康检查 |

- 用户身份：从 `X-Trim-Userid` Header 取；本地开发无该 Header 用 `local`。
- 静态前端：`/` 与 `/app/shortvideo` 都服务 www/，SPA 回落 index.html（`/api/` 除外）。

## 9. 前端（抖音风格）

- 全屏竖屏单列，垂直滑动切换（上滑下一个、下滑上一个），CSS transform + 触摸/滚轮事件，snap 动画。
- 同时保留 3 个 video 槽（上一个/当前/下一个）实现**预加载**：当前播放，下一个 `preload=auto` 已载入。
- 交互对齐抖音：
  - 单击：暂停/播放
  - 双击：收藏（抖音点赞）
  - 右侧操作栏：收藏、历史、设置、重扫
  - 底部：文件名、进度条（可拖动）、时间
  - 顶部/侧：静音切换、循环（默认开）
- 断点续播：进入视频 seek 到 `progress[id].pos`。
- 空状态：无授权目录或无视频时，提示去应用设置授权目录 + 重扫按钮。
- 进度节流上报（每 2-3 秒 + 暂停/离开时）。
- 视觉：黑底、白字、操作图标，毛玻璃面板，抖音式圆角与动效。

## 10. cmd/main 启停

- 按 `uname -m` 选 `bin/shortvideo-server-amd64` 或 `-arm64`。
- 传入：`SOCKET_PATH=${TRIM_APPDEST}/app.sock`、`GATEWAY_PREFIX=/app/shortvideo`、`DATA_DIR=${TRIM_PKGVAR}`、`WWW_DIR=${TRIM_APPDEST}/ui/www`、`ACCESSIBLE_PATHS=${TRIM_DATA_ACCESSIBLE_PATHS}`。
- PID 文件 `${TRIM_PKGVAR}/app.pid`；日志 `${TRIM_PKGVAR}/app.log`。
- start/stop/status，退出码 0/1/3。

## 11. 构建流程（scripts/build.ps1 / build.sh）

1. `cd backend && GOOS=linux GOARCH=amd64 go build -o ../shortvideo/app/bin/shortvideo-server-amd64`
2. `GOOS=linux GOARCH=arm64 go build -o ../shortvideo/app/bin/shortvideo-server-arm64`
3. 拷贝 `frontend/*` → `shortvideo/app/ui/www/`
4. （需 fnpack 时）`fnpack build --directory shortvideo` → `shortvideo.fpk`

本地开发：`go run backend/. -port 8080 -www frontend` 直接起 TCP 服务调试（不走 socket）。

## 12. 首版范围（对齐 PRD）

✅ 多目录递归扫描、全屏上滑/下滑、随机去重、预加载、播放/暂停/静音/拖动/循环、收藏、历史、重扫、断点续播。
❌ 转码、智能推荐、账号体系、云同步、评论社交（PRD 暂不支持）。
