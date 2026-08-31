package main

import (
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
)

// 环境变量（由飞牛 fnOS 注入，见官方环境变量文档）：
//   TRIM_APPDEST            应用 target 目录（二进制与 www 所在）
//   TRIM_PKGVAR             运行时数据目录（重启保留，存放索引/用户态）
//   TRIM_DATA_ACCESSIBLE_PATHS  用户授权的可访问目录（: 分隔）
//
// 本地开发可用 -port / -www / -data / -roots 参数覆盖。

func main() {
	// 本地开发参数
	devPort := flag.Int("port", 0, "本地开发 TCP 端口（生产用 SOCKET_PATH）")
	devWWW := flag.String("www", "", "前端静态目录（默认 TRIM_APPDEST/ui/www 或 ../frontend）")
	devData := flag.String("data", "", "数据目录（默认 TRIM_PKGVAR 或 ./data）")
	devRoots := flag.String("roots", "", "扫描根目录，: 分隔（默认 TRIM_DATA_ACCESSIBLE_PATHS）")
	devPrefix := flag.String("prefix", "", "网关前缀（默认 /app/shortvideo）")
	flag.Parse()

	// 网关前缀
	prefix := *devPrefix
	if prefix == "" {
		prefix = "/app/shortvideo"
	}

	// 静态目录
	wwwDir := *devWWW
	if wwwDir == "" {
		if v := os.Getenv("TRIM_APPDEST"); v != "" {
			wwwDir = filepath.Join(v, "ui", "www")
		} else {
			wwwDir, _ = filepath.Abs(filepath.Join(".", "frontend"))
		}
	}

	// 数据目录
	dataDir := *devData
	if dataDir == "" {
		if v := os.Getenv("TRIM_PKGVAR"); v != "" {
			dataDir = v
		} else {
			dataDir, _ = filepath.Abs(filepath.Join(".", "data"))
		}
	}
	_ = os.MkdirAll(dataDir, 0o755)

	// 授权目录（开发参数用 ; 分隔，避免 Windows 盘符 C: 被 : 分割；
	// 生产环境 TRIM_DATA_ACCESSIBLE_PATHS 在 Linux 下用 : 分隔）
	roots := splitPathsSep(*devRoots, ";")
	if len(roots) == 0 {
		roots = splitPaths(os.Getenv("TRIM_DATA_ACCESSIBLE_PATHS"))
	}

	log.Printf("[shortvideo] prefix=%s www=%s data=%s roots=%v", prefix, wwwDir, dataDir, roots)

	scanner := newScanner(dataDir, roots)
	scanner.Load()
	states := newStateManager(dataDir, scanner)
	// 启动时若无索引或授权目录有内容但索引为空，后台扫描
	if len(scanner.Get().Videos) == 0 && len(roots) > 0 {
		go func() {
			_, _ = scanner.Scan()
			states.ReconcileAll()
		}()
	}

	app := &App{
		scanner: scanner,
		states:  states,
		roots:   roots,
		wwwDir:  wwwDir,
		prefix:  prefix,
	}

	handler := app.NewHandler()

	socketPath := os.Getenv("SOCKET_PATH")
	if socketPath != "" {
		// 生产：监听 Unix Socket（统一网关转发到此）
		_ = os.Remove(socketPath) // 清理残留
		ln, err := net.Listen("unix", socketPath)
		if err != nil {
			log.Fatalf("监听 socket 失败 %s: %v", socketPath, err)
		}
		// 网关以应用用户转发，放宽 socket 权限
		_ = os.Chmod(socketPath, 0o666)
		log.Printf("[shortvideo] 监听 unix socket: %s", socketPath)
		srv := &http.Server{Handler: handler}
		if err := srv.Serve(ln); err != nil {
			log.Fatalf("服务退出: %v", err)
		}
		return
	}

	// 本地开发：监听 TCP
	port := *devPort
	if port == 0 {
		port = 8080
	}
	addr := ":" + itoa(port)
	log.Printf("[shortvideo] 本地开发模式，监听 http://localhost%s%s", addr, prefix)
	srv := &http.Server{Addr: addr, Handler: handler}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("服务退出: %v", err)
	}
}

func itoa(i int) string {
	const digits = "0123456789"
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{digits[i%10]}, b...)
		i /= 10
	}
	return string(b)
}
