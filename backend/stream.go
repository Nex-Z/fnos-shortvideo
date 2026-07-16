package main

import (
	"net/http"
	"os"
	"path/filepath"
)

// serveStream 输出视频文件，原生支持 HTTP Range（进度拖动/跳播）。
// 按 ID 查索引，并二次校验路径必须位于授权目录内，防穿越。
func (a *App) serveStream(w http.ResponseWriter, r *http.Request, id string) {
	v, ok := a.scanner.Find(id)
	if !ok {
		http.NotFound(w, r)
		return
	}
	clean := filepath.Clean(v.Path)
	if !underAny(clean, a.roots) {
		// 索引内的路径理论上必在授权目录；此为防御性校验
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(clean)
	if err != nil {
		http.Error(w, "无法打开文件", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		http.Error(w, "无法读取文件信息", http.StatusInternalServerError)
		return
	}
	// 防止目录被当作文件服务
	if fi.IsDir() {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Content-Type", mimeForExt(clean))
	w.Header().Set("Accept-Ranges", "bytes")
	// 允许前端跨标签/同源播放（统一网关同源，这里主要设缓存与范围）
	w.Header().Set("Cache-Control", "no-store")

	// http.ServeContent 自动处理 Range、If-Range、Last-Modified、ETag
	http.ServeContent(w, r, clean, fi.ModTime(), f)
}
