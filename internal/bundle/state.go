package bundle

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Entry records the last synced version of one bundle and the manifest
// (path -> sha256) that was on disk right after that sync. Push sends
// Version as Parent; pull uses Manifest to detect local modifications.
type Entry struct {
	Version  int               `json:"version"`
	Manifest map[string]string `json:"manifest"`
	Synced   time.Time         `json:"synced"`
}

// State is the client's sync state (~/.config/stift/state.json, override
// with STIFT_SKILLS_STATE), keyed by server, scope, agent, project and unit name.
type State struct {
	Bundles map[string]Entry `json:"bundles"`
	path    string
}

// StatePath returns the state file location.
func StatePath() (string, error) {
	if p := os.Getenv("STIFT_SKILLS_STATE"); p != "" {
		return p, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "stift", "state.json"), nil
}

// LoadState reads the state file; a missing file yields empty state.
func LoadState() (*State, error) {
	p, err := StatePath()
	if err != nil {
		return nil, err
	}
	st := &State{Bundles: map[string]Entry{}, path: p}
	data, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return st, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(data, st); err != nil {
		return nil, err
	}
	if st.Bundles == nil {
		st.Bundles = map[string]Entry{}
	}
	return st, nil
}

// StateKey builds the map key for one bundle unit.
func StateKey(server, scope, agent, project, name string) string {
	return strings.Join([]string{strings.TrimRight(server, "/"), scope, agent, project, name}, "|")
}

// Get returns the entry for a unit (zero Entry if never synced).
func (s *State) Get(server, scope, agent, project, name string) Entry {
	return s.Bundles[StateKey(server, scope, agent, project, name)]
}

// Set records a sync and writes the file.
func (s *State) Set(server, scope, agent, project, name string, version int, manifest map[string]string) error {
	s.Bundles[StateKey(server, scope, agent, project, name)] = Entry{Version: version, Manifest: manifest, Synced: time.Now().UTC()}
	return s.Save()
}

// Forget drops the entry for a unit and writes the file.
func (s *State) Forget(server, scope, agent, project, name string) error {
	delete(s.Bundles, StateKey(server, scope, agent, project, name))
	return s.Save()
}

// Names returns the unit names recorded for (server, scope, agent, project).
func (s *State) Names(server, scope, agent, project string) []string {
	prefix := StateKey(server, scope, agent, project, "")
	var out []string
	for k := range s.Bundles {
		if strings.HasPrefix(k, prefix) {
			out = append(out, strings.TrimPrefix(k, prefix))
		}
	}
	return out
}

// Save writes the state file atomically.
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
