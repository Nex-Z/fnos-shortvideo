package main

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Video 描述一个被索引的视频文件。
type Video struct {
	ID    string `json:"id"`
	Path  string `json:"path"`
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
}

// Index 是视频索引（共享，所有用户）。
type Index struct {
	ScannedAt string   `json:"scannedAt"`
	Roots     []string `json:"roots"`
	Videos    []Video  `json:"videos"`
	byID      map[string]*Video `json:"-"`
}

// ScanStatus 记录后台扫描状态，供前端查询（纯数据，不含锁）。
type ScanStatus struct {
	Running bool   `json:"running"`
	Count   int    `json:"count"`
	Message string `json:"message"`
	LastAt  string `json:"lastAt"`
}

// Scanner 管理索引与扫描状态。
type Scanner struct {
	mu       sync.RWMutex
	idx      *Index
	statusMu sync.Mutex
	status   ScanStatus
	roots    []string // 授权目录（TRIM_DATA_ACCESSIBLE_PATHS）
	dataDir  string
}

func newScanner(dataDir string, roots []string) *Scanner {
	return &Scanner{
		roots:   roots,
		dataDir: dataDir,
	}
}

// Load 从磁盘加载已有索引。
func (s *Scanner) Load() {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := os.ReadFile(filepath.Join(s.dataDir, "index.json"))
	if err != nil {
		s.idx = &Index{byID: map[string]*Video{}}
		return
	}
	var idx Index
	if err := json.Unmarshal(b, &idx); err != nil {
		s.idx = &Index{byID: map[string]*Video{}}
		return
	}
	idx.byID = map[string]*Video{}
	for i := range idx.Videos {
		idx.byID[idx.Videos[i].ID] = &idx.Videos[i]
	}
	s.idx = &idx
	s.statusMu.Lock()
	s.status.Count = len(idx.Videos)
	s.status.LastAt = idx.ScannedAt
	s.statusMu.Unlock()
}

// Get 返回当前索引副本（只读快照）。
func (s *Scanner) Get() *Index {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.idx
}

// Find 按 ID 查找视频。
func (s *Scanner) Find(id string) (*Video, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.idx == nil || s.idx.byID == nil {
		return nil, false
	}
	v, ok := s.idx.byID[id]
	return v, ok
}

// Status 返回扫描状态快照。
func (s *Scanner) Status() ScanStatus {
	s.statusMu.Lock()
	defer s.statusMu.Unlock()
	return s.status
}

// ScanAsync 在后台执行扫描。
func (s *Scanner) ScanAsync() {
	go s.scan()
}

// Scan 同步执行扫描，返回视频数与错误。
func (s *Scanner) Scan() (int, error) {
	return s.scan()
}

func (s *Scanner) scan() (int, error) {
	s.statusMu.Lock()
	if s.status.Running {
		s.statusMu.Unlock()
		return 0, nil
	}
	s.status.Running = true
	s.status.Message = "扫描中..."
	s.statusMu.Unlock()

	defer func() {
		s.statusMu.Lock()
		s.status.Running = false
		s.statusMu.Unlock()
	}()

	roots := s.roots
	videos := make([]Video, 0, 256)
	seen := map[string]bool{}

	for _, root := range roots {
		// 清理并校验根目录存在
		root = filepath.Clean(root)
		info, err := os.Stat(root)
		if err != nil || !info.IsDir() {
			continue
		}
		filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil // 跳过无权限/不存在的子项
			}
			if d.IsDir() {
				return nil
			}
			name := d.Name()
			if !isVideoFile(name) {
				return nil
			}
			abs, _ := filepath.Abs(path)
			abs = filepath.Clean(abs)
			if seen[abs] {
				return nil
			}
			seen[abs] = true
			fi, err := d.Info()
			if err != nil {
				return nil
			}
			videos = append(videos, Video{
				ID:    videoID(abs),
				Path:  abs,
				Name:  name,
				Size:  fi.Size(),
				Mtime: fi.ModTime().Unix(),
			})
			return nil
		})
	}

	idx := &Index{
		ScannedAt: time.Now().Format(time.RFC3339),
		Roots:     roots,
		Videos:    videos,
		byID:      map[string]*Video{},
	}
	for i := range videos {
		idx.byID[videos[i].ID] = &videos[i]
	}

	s.mu.Lock()
	s.idx = idx
	s.mu.Unlock()

	// 持久化
	if err := os.MkdirAll(s.dataDir, 0o755); err == nil {
		b, _ := json.MarshalIndent(idx, "", "  ")
		os.WriteFile(filepath.Join(s.dataDir, "index.json"), b, 0o644)
	}

	s.statusMu.Lock()
	s.status.Count = len(videos)
	s.status.LastAt = idx.ScannedAt
	s.status.Message = "扫描完成"
	s.statusMu.Unlock()

	return len(videos), nil
}

// ReconcileDeck 在重扫后对账用户播放队列：移除已删除 ID，追加新增 ID。
// 由 UserState 在加载/重扫时调用。
func (s *Scanner) KnownIDs() map[string]bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m := map[string]bool{}
	if s.idx == nil {
		return m
	}
	for id := range s.idx.byID {
		m[id] = true
	}
	return m
}
