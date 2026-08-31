package main

import (
	"testing"
)

func testScanner(ids ...string) *Scanner {
	idx := &Index{Videos: make([]Video, 0, len(ids)), byID: map[string]*Video{}}
	for _, id := range ids {
		idx.Videos = append(idx.Videos, Video{ID: id, Name: id})
	}
	for i := range idx.Videos {
		idx.byID[idx.Videos[i].ID] = &idx.Videos[i]
	}
	return &Scanner{idx: idx, status: ScanStatus{LastAt: "done"}}
}

func TestRoundEndPreloadMatchesNext(t *testing.T) {
	st := &UserState{
		dataDir:  t.TempDir(),
		uid:      "round",
		Deck:     []string{"a", "b", "c"},
		Cursor:   2,
		Progress: map[string]ProgressEntry{},
	}
	cur, prev, next := st.NeighborIDs()
	if cur != "c" || prev != "b" || next == "" {
		t.Fatalf("unexpected neighbors: cur=%q prev=%q next=%q", cur, prev, next)
	}
	if next == cur {
		t.Fatalf("next round starts with current item %q", cur)
	}
	if got := st.Next(); got != next {
		t.Fatalf("preloaded next %q differs from switched next %q", next, got)
	}
	if st.Cursor != 0 || len(st.NextDeck) != 0 {
		t.Fatalf("round was not promoted correctly: cursor=%d pending=%v", st.Cursor, st.NextDeck)
	}
	if _, prevAfter, _ := st.NeighborIDs(); prevAfter != "c" {
		t.Fatalf("previous round boundary was lost: prev=%q", prevAfter)
	}
	if got := st.Prev(); got != "c" {
		t.Fatalf("could not return across round boundary: %q", got)
	}
	if got := st.Next(); got != next {
		t.Fatalf("forward order changed after returning: got=%q want=%q", got, next)
	}
}

func TestReconcilePreservesCurrentAndAddsFreshVideo(t *testing.T) {
	st := &UserState{
		dataDir:   t.TempDir(),
		uid:       "reconcile",
		Deck:      []string{"deleted", "current", "old"},
		NextDeck:  []string{"old", "current", "deleted"},
		Cursor:    1,
		Favorites: []string{"deleted", "current"},
		History:   []HistoryEntry{{ID: "deleted"}, {ID: "current"}},
		Progress:  map[string]ProgressEntry{"deleted": {}, "current": {}},
		Last:      &LastPlayed{ID: "deleted"},
	}
	st.reconcile(testScanner("current", "old", "fresh"))

	if got := st.CurrentID(); got != "current" {
		t.Fatalf("current item changed during reconcile: %q", got)
	}
	if len(st.Deck) != 3 || !containsID(st.Deck, "fresh") || containsID(st.Deck, "deleted") {
		t.Fatalf("deck not reconciled: %v", st.Deck)
	}
	if st.NextDeck != nil {
		t.Fatalf("pending round should be invalidated: %v", st.NextDeck)
	}
	if st.PrevDeck != nil {
		t.Fatalf("previous round should be invalidated: %v", st.PrevDeck)
	}
	if st.Last != nil || containsID(st.Favorites, "deleted") {
		t.Fatalf("stale user data remains: last=%v favorites=%v", st.Last, st.Favorites)
	}
	if _, ok := st.Progress["deleted"]; ok {
		t.Fatal("stale progress remains")
	}
}

func TestOldProgressCannotOverrideCurrentLastPlayed(t *testing.T) {
	st := &UserState{
		dataDir:  t.TempDir(),
		uid:      "progress",
		Deck:     []string{"old", "new"},
		Cursor:   1,
		Progress: map[string]ProgressEntry{},
		Last:     &LastPlayed{ID: "new"},
	}
	st.SaveProgress("old", 12, 30)
	if st.Last == nil || st.Last.ID != "new" {
		t.Fatalf("old progress replaced current last played: %+v", st.Last)
	}
	if p := st.Progress["old"]; p.Pos != 12 {
		t.Fatalf("old progress itself was not saved: %+v", p)
	}
	st.SaveProgress("new", 8, 30)
	if st.Last == nil || st.Last.ID != "new" || st.Last.Pos != 8 {
		t.Fatalf("current progress did not update last played: %+v", st.Last)
	}
}

func containsID(ids []string, want string) bool {
	for _, id := range ids {
		if id == want {
			return true
		}
	}
	return false
}
