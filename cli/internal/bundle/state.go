package bundle

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
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

// InstallEntry records provenance of a detached copy made by
// `stift skills install`: which org version was copied and the manifest
// written, so upgrades can tell local edits from the copy.
type InstallEntry struct {
	From      string            `json:"from"` // "org" today; a registry address later
	Version   int               `json:"version"`
	Manifest  map[string]string `json:"manifest"`
	Installed time.Time         `json:"installed"`
}

// State is the client's sync state (~/.config/stift/state.json, override
// with STIFT_SKILLS_STATE). Bundles are keyed by server, scope, agent,
// project and unit name; Installs by server, agent and unit name.
type State struct {
	Bundles  map[string]Entry        `json:"bundles"`
	Installs map[string]InstallEntry `json:"installs,omitempty"`
	path     string
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
	st := &State{Bundles: map[string]Entry{}, Installs: map[string]InstallEntry{}, path: p}
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
	if st.Installs == nil {
		st.Installs = map[string]InstallEntry{}
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

// InstallKey builds the map key for one installed unit.
func InstallKey(server, agent, name string) string {
	return strings.Join([]string{strings.TrimRight(server, "/"), agent, name}, "|")
}

// GetInstall returns the install entry for a unit (zero if never installed).
func (s *State) GetInstall(server, agent, name string) InstallEntry {
	return s.Installs[InstallKey(server, agent, name)]
}

// SetInstall records an install and writes the file.
func (s *State) SetInstall(server, agent, name string, e InstallEntry) error {
	e.Installed = time.Now().UTC()
	s.Installs[InstallKey(server, agent, name)] = e
	return s.Save()
}

// ForgetInstall drops the install entry for a unit and writes the file.
func (s *State) ForgetInstall(server, agent, name string) error {
	delete(s.Installs, InstallKey(server, agent, name))
	return s.Save()
}

// InstallNames returns the (agent, name) pairs installed from server, sorted.
func (s *State) InstallNames(server string) [][2]string {
	prefix := strings.TrimRight(server, "/") + "|"
	var out [][2]string
	for k := range s.Installs {
		if !strings.HasPrefix(k, prefix) {
			continue
		}
		rest := strings.SplitN(strings.TrimPrefix(k, prefix), "|", 2)
		if len(rest) == 2 {
			out = append(out, [2]string{rest[0], rest[1]})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i][0] != out[j][0] {
			return out[i][0] < out[j][0]
		}
		return out[i][1] < out[j][1]
	})
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
