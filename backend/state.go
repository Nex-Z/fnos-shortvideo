package main

import (
	"encoding/json"
	"math/rand/v2"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ProgressEntry 记录某视频的播放进度。
type ProgressEntry struct {
	Pos float64 `json:"pos"` // 秒
	Dur float64 `json:"dur"` // 总时长（秒），前端从 video.duration 取
	Ts  int64   `json:"ts"`  // 更新时间戳
}

// HistoryEntry 记录一次播放。
type HistoryEntry struct {
	ID string `json:"id"`
	Ts int64  `json:"ts"`
}

// LastPlayed 记录最近播放的视频与位置（用于退出后续播）。
type LastPlayed struct {
	ID  string  `json:"id"`
	Pos float64 `json:"pos"`
}

// UserState 是单个用户的全部状态（队列、收藏、历史、进度）。
type UserState struct {
	mu      sync.Mutex
	uid     string
	dataDir string

	Deck      []string                 `json:"deck"`
	Cursor    int                      `json:"cursor"`
	Favorites []string                 `json:"favorites"`
	History   []HistoryEntry           `json:"history"`
	Progress  map[string]ProgressEntry `json:"progress"`
	Last      *LastPlayed              `json:"last"`
}

const historyCap = 200

// StateManager 按需加载并缓存用户状态。
type StateManager struct {
	mu      sync.Mutex
	users   map[string]*UserState
	dataDir string
	scanner *Scanner
}

func newStateManager(dataDir string, scanner *Scanner) *StateManager {
	return &StateManager{
		users:   map[string]*UserState{},
		dataDir: dataDir,
		scanner: scanner,
	}
}

func (m *StateManager) Get(uid string) *UserState {
	uid = sanitizeUID(uid)
	m.mu.Lock()
	st, ok := m.users[uid]
	if !ok {
		st = &UserState{
			uid:       uid,
			dataDir:   filepath.Join(m.dataDir, "users"),
			Favorites: []string{},
			History:   []HistoryEntry{},
			Progress:  map[string]ProgressEntry{},
		}
		st.load()
		st.reconcile(m.scanner)
		m.users[uid] = st
	}
	m.mu.Unlock()
	return st
}

func (st *UserState) file() string {
	return filepath.Join(st.dataDir, st.uid+".json")
}

func (st *UserState) load() {
	b, err := os.ReadFile(st.file())
	if err != nil {
		return
	}
	var tmp UserState
	if err := json.Unmarshal(b, &tmp); err != nil {
		return
	}
	st.Deck = tmp.Deck
	st.Cursor = tmp.Cursor
	st.Favorites = tmp.Favorites
	st.History = tmp.History
	if st.Favorites == nil {
		st.Favorites = []string{}
	}
	if st.History == nil {
		st.History = []HistoryEntry{}
	}
	st.Progress = tmp.Progress
	if st.Progress == nil {
		st.Progress = map[string]ProgressEntry{}
	}
	st.Last = tmp.Last
}

func (st *UserState) save() {
	st.dataDir = filepath.Clean(st.dataDir)
	if err := os.MkdirAll(st.dataDir, 0o755); err != nil {
		return
	}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return
	}
	os.WriteFile(st.file(), b, 0o644)
}

// reconcile 在加载后或重扫后对账：移除已删除 ID、追加新增 ID，必要时重建队列。
func (st *UserState) reconcile(scanner *Scanner) {
	st.mu.Lock()
	defer st.mu.Unlock()
	known := scanner.KnownIDs()
	if len(known) == 0 {
		return
	}

	// 过滤掉已不存在的 ID
	if len(st.Deck) > 0 {
		cleaned := st.Deck[:0]
		for _, id := range st.Deck {
			if known[id] {
				cleaned = append(cleaned, id)
			}
		}
		st.Deck = cleaned
	}

	// 追加新增的 ID（不在当前 deck 中的）
	inDeck := map[string]bool{}
	for _, id := range st.Deck {
		inDeck[id] = true
	}
	var fresh []string
	for id := range known {
		if !inDeck[id] {
			fresh = append(fresh, id)
		}
	}
	rand.Shuffle(len(fresh), func(i, j int) { fresh[i], fresh[j] = fresh[j], fresh[i] })
	st.Deck = append(st.Deck, fresh...)

	// 队列空或游标越界 -> 整体洗牌
	if len(st.Deck) == 0 {
		return
	}
	if st.Cursor >= len(st.Deck) {
		st.Cursor = len(st.Deck) - 1
	}
	if st.Cursor < 0 {
		st.Cursor = 0
	}

	// 清理收藏/进度中已失效的项（可选，保持整洁）
	st.Favorites = filterIDs(st.Favorites, known)
	st.save()
}

func filterIDs(in []string, known map[string]bool) []string {
	out := in[:0]
	for _, id := range in {
		if known[id] {
			out = append(out, id)
		}
	}
	return out
}

// CurrentID 返回当前游标处的视频 ID。
func (st *UserState) CurrentID() string {
	st.mu.Lock()
	defer st.mu.Unlock()
	if len(st.Deck) == 0 {
		return ""
	}
	if st.Cursor < 0 || st.Cursor >= len(st.Deck) {
		st.Cursor = 0
	}
	return st.Deck[st.Cursor]
}

// Next 上滑：前进一个，到末尾则重新洗牌（首项避开当前），返回新当前 ID。
func (st *UserState) Next() string {
	st.mu.Lock()
	defer st.mu.Unlock()
	if len(st.Deck) == 0 {
		return ""
	}
	if st.Cursor < len(st.Deck)-1 {
		st.Cursor++
	} else {
		// 到达末尾，重新洗牌，避免首项与当前相同
		cur := st.Deck[st.Cursor]
		rand.Shuffle(len(st.Deck), func(i, j int) { st.Deck[i], st.Deck[j] = st.Deck[j], st.Deck[i] })
		if st.Deck[0] == cur && len(st.Deck) > 1 {
			st.Deck[0], st.Deck[1] = st.Deck[1], st.Deck[0]
		}
		st.Cursor = 0
	}
	st.save()
	return st.Deck[st.Cursor]
}

// Prev 下滑：后退一个，到开头不动，返回新当前 ID。
func (st *UserState) Prev() string {
	st.mu.Lock()
	defer st.mu.Unlock()
	if len(st.Deck) == 0 {
		return ""
	}
	if st.Cursor > 0 {
		st.Cursor--
	}
	st.save()
	return st.Deck[st.Cursor]
}

// Jump 跳转到指定 ID：若在 deck 中则移动游标，否则插到当前位置后。
func (st *UserState) Jump(id string) string {
	st.mu.Lock()
	defer st.mu.Unlock()
	if len(st.Deck) == 0 || id == "" {
		return ""
	}
	for i, d := range st.Deck {
		if d == id {
			st.Cursor = i
			st.save()
			return id
		}
	}
	// 不在 deck 中（理论上重扫后已对账），插到当前位置后
	pos := st.Cursor + 1
	if pos > len(st.Deck) {
		pos = len(st.Deck)
	}
	st.Deck = append(st.Deck[:pos], append([]string{id}, st.Deck[pos:]...)...)
	st.Cursor = pos
	st.save()
	return id
}

// EnsureCurrent 确保游标指向有效项，返回当前 ID（无视频返回空）。
func (st *UserState) EnsureCurrent() string {
	st.mu.Lock()
	defer st.mu.Unlock()
	if len(st.Deck) == 0 {
		return ""
	}
	if st.Cursor < 0 || st.Cursor >= len(st.Deck) {
		st.Cursor = 0
	}
	return st.Deck[st.Cursor]
}

// NeighborIDs 返回当前、上一个、下一个 ID（用于预加载；到边界返回空串）。
func (st *UserState) NeighborIDs() (cur, prev, next string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if len(st.Deck) == 0 {
		return "", "", ""
	}
	if st.Cursor < 0 || st.Cursor >= len(st.Deck) {
		st.Cursor = 0
	}
	cur = st.Deck[st.Cursor]
	if st.Cursor > 0 {
		prev = st.Deck[st.Cursor-1]
	}
	if st.Cursor < len(st.Deck)-1 {
		next = st.Deck[st.Cursor+1]
	}
	return
}

// ToggleFavorite 切换收藏，返回新状态。
func (st *UserState) ToggleFavorite(id string) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	for i, f := range st.Favorites {
		if f == id {
			st.Favorites = append(st.Favorites[:i], st.Favorites[i+1:]...)
			st.save()
			return false
		}
	}
	st.Favorites = append(st.Favorites, id)
	st.save()
	return true
}

// IsFavorite 判断是否已收藏。
func (st *UserState) IsFavorite(id string) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	for _, f := range st.Favorites {
		if f == id {
			return true
		}
	}
	return false
}

// SaveProgress 保存某视频播放进度。
func (st *UserState) SaveProgress(id string, pos, dur float64) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.Progress[id] = ProgressEntry{Pos: pos, Dur: dur, Ts: time.Now().Unix()}
	st.Last = &LastPlayed{ID: id, Pos: pos}
	st.save()
}

// GetProgress 读取某视频播放进度。
func (st *UserState) GetProgress(id string) (ProgressEntry, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	p, ok := st.Progress[id]
	return p, ok
}

// SetLast 设置最近播放（进入视频时调用，便于续播）。
func (st *UserState) SetLast(id string, pos float64) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.Last = &LastPlayed{ID: id, Pos: pos}
	st.save()
}

// GetLast 返回最近播放。
func (st *UserState) GetLast() *LastPlayed {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.Last
}

// AddHistory 记录一次播放（去重，最新在前，上限 historyCap）。
func (st *UserState) AddHistory(id string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	out := make([]HistoryEntry, 0, len(st.History)+1)
	out = append(out, HistoryEntry{ID: id, Ts: time.Now().Unix()})
	for _, h := range st.History {
		if h.ID == id {
			continue
		}
		out = append(out, h)
		if len(out) >= historyCap {
			break
		}
	}
	st.History = out
	st.save()
}

// Snapshot 返回可序列化的状态快照（不含互斥锁）。
func (st *UserState) Snapshot() UserState {
	st.mu.Lock()
	defer st.mu.Unlock()
	fav := make([]string, len(st.Favorites))
	copy(fav, st.Favorites)
	hist := make([]HistoryEntry, len(st.History))
	copy(hist, st.History)
	prog := make(map[string]ProgressEntry, len(st.Progress))
	for k, v := range st.Progress {
		prog[k] = v
	}
	deck := make([]string, len(st.Deck))
	copy(deck, st.Deck)
	var last *LastPlayed
	if st.Last != nil {
		l := *st.Last
		last = &l
	}
	return UserState{
		Deck: deck, Cursor: st.Cursor,
		Favorites: fav, History: hist, Progress: prog, Last: last,
	}
}
