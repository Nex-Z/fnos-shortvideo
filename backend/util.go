package main

import (
	"crypto/sha1"
	"encoding/hex"
	"path/filepath"
	"strings"
)

// videoExts 是被识别为视频的文件扩展名（小写，不含点）。
var videoExts = map[string]bool{
	"mp4": true, "m4v": true, "mov": true, "mkv": true, "webm": true,
	"avi": true, "flv": true, "ts": true, "wmv": true, "mpg": true,
	"mpeg": true, "3gp": true, "ogv": true, "rm": true, "rmvb": true,
	"mts": true, "m2ts": true, "vob": true, "f4v": true,
}

// isVideoFile 判断路径是否为视频文件（按扩展名）。
func isVideoFile(name string) bool {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	return videoExts[ext]
}

// videoID 根据绝对路径生成稳定 ID（SHA1 前 16 位 hex）。
// 跨重扫保持稳定，使收藏/进度在新增/删除文件后仍能匹配。
func videoID(absPath string) string {
	sum := sha1.Sum([]byte(absPath))
	return hex.EncodeToString(sum[:])[:16]
}

// mimeForExt 返回视频扩展名对应的 MIME（用于流响应）。
func mimeForExt(name string) string {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	switch ext {
	case "mp4", "m4v":
		return "video/mp4"
	case "webm":
		return "video/webm"
	case "ogv":
		return "video/ogg"
	case "mov":
		return "video/quicktime"
	case "mkv":
		return "video/x-matroska"
	case "ts", "mts", "m2ts":
		return "video/mp2t"
	case "flv":
		return "video/x-flv"
	case "3gp":
		return "video/3gpp"
	case "wmv":
		return "video/x-ms-wmv"
	case "avi":
		return "video/x-msvideo"
	default:
		return "application/octet-stream"
	}
}

// sanitizeUID 将用户 ID 规整为文件名安全字符串（用于 users/{uid}.json）。
func sanitizeUID(uid string) string {
	if uid == "" {
		return "local"
	}
	var b strings.Builder
	for _, r := range uid {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	s := b.String()
	if s == "" {
		return "local"
	}
	return s
}

// splitPaths 按 : 分割路径列表（fnOS 的 TRIM_DATA_ACCESSIBLE_PATHS 等）。
func splitPaths(joined string) []string {
	return splitPathsSep(joined, ":")
}

// splitPathsSep 按 sep 分割路径列表。
func splitPathsSep(joined, sep string) []string {
	var out []string
	for _, p := range strings.Split(joined, sep) {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// underAny 检查 path 是否位于 roots 任一目录下（词法比较，已 Clean）。
func underAny(path string, roots []string) bool {
	for _, root := range roots {
		if path == root {
			return true
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			continue
		}
		if rel != "." && !strings.HasPrefix(rel, "..") && !strings.HasPrefix(rel, "../") {
			return true
		}
		// rel == "." 表示 path == root，上面已处理
	}
	return false
}
