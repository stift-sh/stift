package daemon

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/stift-sh/stift/internal/agents"
)

// State is the daemon's persisted memory across runs. Pushed lets the push
// pass skip sessions whose content is unchanged; Restored lets the reconcile
// pass avoid re-restoring a session it already wrote.
type State struct {
	path     string
	Pushed   map[string]string `json:"pushed"`   // session Key -> fingerprint
	Restored map[string]bool   `json:"restored"` // restored server session IDs
}

func statePath() (string, error) {
	if p := os.Getenv("STIFT_STATE"); p != "" {
		return p, nil
	}
	dir, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "stift", "sync-state.json"), nil
}

// LoadState reads the saved sync state; a missing file yields an empty state.
func LoadState() (*State, error) {
	path, err := statePath()
	if err != nil {
		return nil, err
	}
	s := &State{path: path, Pushed: map[string]string{}, Restored: map[string]bool{}}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(data, s); err != nil {
		return nil, err
	}
	if s.Pushed == nil {
		s.Pushed = map[string]string{}
	}
	if s.Restored == nil {
		s.Restored = map[string]bool{}
	}
	s.path = path
	return s, nil
}

// Save persists the state atomically.
func (s *State) Save() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// fingerprint captures a session's identity for change detection: the newest
// modification time plus the file count and total byte size. Any edit to a
// tracked file bumps the mtime; adding/removing files bumps count/size.
func fingerprint(sess agents.LocalSession) string {
	var size int64
	for _, f := range sess.Files {
		if info, err := os.Stat(f); err == nil {
			size += info.Size()
		}
	}
	return fmt.Sprintf("%d-%d-%d", sess.ModTime.UnixNano(), len(sess.Files), size)
}
