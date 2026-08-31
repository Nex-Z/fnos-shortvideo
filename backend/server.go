package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// App 持有运行时依赖与全部 HTTP 处理逻辑。
type App struct {
	scanner *Scanner
	states  *StateManager
	roots   []string // 授权目录（TRIM_DATA_ACCESSIBLE_PATHS）
	wwwDir  string   // 前端静态文件目录
	prefix  string   // 统一网关前缀，如 /app/shortvideo
}

// NewHandler 构建根 HTTP 处理器。
func (a *App) NewHandler() http.Handler {
	return http.HandlerFunc(a.route)
}

// route 统一入口：剥离网关前缀后按路径分发。
func (a *App) route(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path

	// 精确匹配前缀（无尾斜杠）-> 重定向到带斜杠，保证相对资源路径解析正确
	if p == a.prefix {
		http.Redirect(w, r, p+"/", http.StatusFound)
		return
	}

	// 剥离前缀
	if a.prefix != "" && a.prefix != "/" && strings.HasPrefix(p, a.prefix+"/") {
		p = strings.TrimPrefix(p, a.prefix)
	} else if a.prefix != "" && a.prefix != "/" && p == a.prefix+"/" {
		p = "/"
	}
	if p == "" {
		p = "/"
	}

	// API 路由
	if strings.HasPrefix(p, "/api/") {
		a.api(w, r, p)
		return
	}

	// 静态资源 / SPA 回落
	a.serveStatic(w, r, p)
}

// api 分发 API 请求。
func (a *App) api(w http.ResponseWriter, r *http.Request, p string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	uid := a.userID(r)

	switch {
	case p == "/api/health":
		writeJSON(w, map[string]any{"ok": true})
		return

	case p == "/api/config":
		st := a.scanner.Status()
		writeJSON(w, map[string]any{
			"roots":       a.roots,
			"scan":        st,
			"total":       len(a.scanner.Get().Videos),
			"gatewayUser": uid,
		})
		return

	case p == "/api/rescan" && r.Method == http.MethodPost:
		go func() {
			_, _ = a.scanner.Scan()
			a.states.ReconcileAll()
		}()
		writeJSON(w, map[string]any{"ok": true, "message": "已触发重扫"})
		return

	case p == "/api/session":
		a.handleSession(w, r, uid, "")
		return

	case p == "/api/session/next" && r.Method == http.MethodPost:
		st := a.states.Get(uid)
		id := st.Next()
		a.handleSession(w, r, uid, id)
		return

	case p == "/api/session/prev" && r.Method == http.MethodPost:
		st := a.states.Get(uid)
		id := st.Prev()
		a.handleSession(w, r, uid, id)
		return

	case p == "/api/session/jump" && r.Method == http.MethodPost:
		var body struct {
			ID string `json:"id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ID == "" {
			http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
			return
		}
		st := a.states.Get(uid)
		id := st.Jump(body.ID)
		a.handleSession(w, r, uid, id)
		return

	case p == "/api/state":
		a.handleState(w, r, uid)
		return

	case p == "/api/favorite" && r.Method == http.MethodPost:
		var body struct {
			ID       string `json:"id"`
			Favorite *bool  `json:"favorite"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ID == "" {
			http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
			return
		}
		st := a.states.Get(uid)
		var now bool
		if body.Favorite != nil {
			// 显式设置目标状态：若与现状不同则切换
			cur := st.IsFavorite(body.ID)
			if cur != *body.Favorite {
				st.ToggleFavorite(body.ID)
			}
			now = *body.Favorite
		} else {
			now = st.ToggleFavorite(body.ID)
		}
		writeJSON(w, map[string]any{"id": body.ID, "favorite": now})
		return

	case p == "/api/progress" && r.Method == http.MethodPost:
		var body struct {
			ID  string  `json:"id"`
			Pos float64 `json:"pos"`
			Dur float64 `json:"dur"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ID == "" {
			http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
			return
		}
		a.states.Get(uid).SaveProgress(body.ID, body.Pos, body.Dur)
		writeJSON(w, map[string]any{"ok": true})
		return

	case strings.HasPrefix(p, "/api/stream/"):
		id := strings.TrimPrefix(p, "/api/stream/")
		// 去掉可能的前缀残留
		id = strings.TrimPrefix(id, a.prefix+"/")
		a.serveStream(w, r, id)
		return

	case strings.HasPrefix(p, "/api/video/"):
		id := strings.TrimPrefix(p, "/api/video/")
		v, ok := a.scanner.Find(id)
		if !ok {
			http.NotFound(w, r)
			return
		}
		st := a.states.Get(uid)
		prog, _ := st.GetProgress(id)
		writeJSON(w, map[string]any{
			"id":       v.ID,
			"name":     v.Name,
			"size":     v.Size,
			"mtime":    v.Mtime,
			"favorite": st.IsFavorite(id),
			"progress": prog,
		})
		return
	}

	http.NotFound(w, r)
}

// handleSession 返回当前会话信息：当前视频 + 邻居 ID（用于预加载）+ 游标位置。
// 若 forceID 非空，表示刚执行了 next/prev/jump，以其为当前。
func (a *App) handleSession(w http.ResponseWriter, r *http.Request, uid, forceID string) {
	st := a.states.Get(uid)
	cur := forceID
	if cur == "" {
		cur = st.EnsureCurrent()
	}
	if cur == "" {
		writeJSON(w, map[string]any{
			"empty":   true,
			"total":   0,
			"cursor":  0,
			"current": nil,
		})
		return
	}
	// 记录历史
	st.AddHistory(cur)

	_, prevID, nextID := st.NeighborIDs()
	v, ok := a.scanner.Find(cur)
	if !ok {
		// 当前 ID 已失效，尝试前进
		nxt := st.Next()
		a.handleSession(w, r, uid, nxt)
		return
	}
	prog, _ := st.GetProgress(cur)
	if forceID != "" {
		// next/prev/jump 一完成就记录新当前，避免旧视频的延迟进度回写造成续播倒退。
		st.SetLast(cur, prog.Pos)
	}
	last := st.GetLast()
	writeJSON(w, map[string]any{
		"empty":   false,
		"total":   len(a.scanner.Get().Videos),
		"cursor":  st.Snapshot().Cursor,
		"current": videoInfo(v, st.IsFavorite(cur), prog),
		"prevId":  prevID,
		"nextId":  nextID,
		"last":    last,
	})
}

func videoInfo(v *Video, fav bool, prog ProgressEntry) map[string]any {
	m := map[string]any{
		"id":       v.ID,
		"name":     v.Name,
		"size":     v.Size,
		"mtime":    v.Mtime,
		"favorite": fav,
	}
	if prog.Pos > 0 || prog.Dur > 0 {
		m["progress"] = prog
	}
	return m
}

// handleState 返回用户完整状态（收藏、历史、进度、最近播放）。
func (a *App) handleState(w http.ResponseWriter, r *http.Request, uid string) {
	st := a.states.Get(uid)
	snap := st.Snapshot()

	// 为收藏/历史附带视频元信息
	idx := a.scanner.Get()
	favList := make([]map[string]any, 0, len(snap.Favorites))
	for _, id := range snap.Favorites {
		if v, ok := idx.byID[id]; ok {
			favList = append(favList, videoInfo(v, true, ProgressEntry{}))
		}
	}
	histList := make([]map[string]any, 0, len(snap.History))
	for _, h := range snap.History {
		if v, ok := idx.byID[h.ID]; ok {
			m := videoInfo(v, st.IsFavorite(h.ID), ProgressEntry{})
			m["ts"] = h.Ts
			histList = append(histList, m)
		}
	}

	writeJSON(w, map[string]any{
		"favorites": favList,
		"history":   histList,
		"last":      snap.Last,
		"cursor":    snap.Cursor,
		"total":     len(idx.Videos),
	})
}

// serveStatic 提供前端静态文件，未知非 API 路径回落到 index.html（SPA）。
func (a *App) serveStatic(w http.ResponseWriter, r *http.Request, rel string) {
	rel = filepath.Clean("/" + rel)
	rel = strings.TrimPrefix(rel, "/")

	if rel == "" || rel == "." || rel == "/" {
		a.serveIndex(w, r)
		return
	}

	fp := filepath.Join(a.wwwDir, rel)
	// 防穿越
	if !strings.HasPrefix(filepath.Clean(fp), filepath.Clean(a.wwwDir)) {
		http.NotFound(w, r)
		return
	}
	info, err := os.Stat(fp)
	if err != nil || info.IsDir() {
		// SPA 回落
		a.serveIndex(w, r)
		return
	}
	http.ServeFile(w, r, fp)
}

func (a *App) serveIndex(w http.ResponseWriter, r *http.Request) {
	fp := filepath.Join(a.wwwDir, "index.html")
	b, err := os.ReadFile(fp)
	if err != nil {
		http.Error(w, "前端未构建", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(b)
}

// userID 从统一网关注入的 Header 取用户身份；本地开发无则用 local。
func (a *App) userID(r *http.Request) string {
	if uid := r.Header.Get("X-Trim-Userid"); uid != "" {
		return uid
	}
	if u := r.Header.Get("X-Trim-Username"); u != "" {
		return u
	}
	return "local"
}

func writeJSON(w http.ResponseWriter, v any) {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}
