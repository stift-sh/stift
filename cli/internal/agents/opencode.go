package agents

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// opencode detects opencode sessions stored under
// $XDG_DATA_HOME/opencode/storage (default ~/.local/share/opencode/storage):
// session metadata, per-session messages and per-message parts.
type opencode struct{}

func (opencode) Name() string { return "opencode" }

func opencodeDataDir(home string) string {
	if x := os.Getenv("XDG_DATA_HOME"); x != "" {
		return filepath.Join(x, "opencode")
	}
	return filepath.Join(home, ".local", "share", "opencode")
}

type opencodeSession struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Directory string `json:"directory"`
	Time      struct {
		Created float64 `json:"created"`
		Updated float64 `json:"updated"`
	} `json:"time"`
}

func (opencode) Detect(home, project string) ([]LocalSession, error) {
	storage := filepath.Join(opencodeDataDir(home), "storage")
	if _, err := os.Stat(storage); err != nil {
		return nil, nil
	}
	var out []LocalSession
	// Session info files live at varying depths across opencode versions;
	// walk the whole session/ tree for ses_*.json.
	filepath.WalkDir(filepath.Join(storage, "session"), func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		name := d.Name()
		if !strings.HasPrefix(name, "ses_") || !strings.HasSuffix(name, ".json") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		var info opencodeSession
		if json.Unmarshal(data, &info) != nil || info.ID == "" {
			return nil
		}
		if project != "" && info.Directory != "" && info.Directory != project {
			return nil
		}
		files := []string{path}
		for _, msgDir := range []string{
			filepath.Join(storage, "message", info.ID),
			filepath.Join(storage, "session", "message", info.ID),
		} {
			msgs, err := os.ReadDir(msgDir)
			if err != nil {
				continue
			}
			for _, m := range msgs {
				if m.IsDir() || !strings.HasSuffix(m.Name(), ".json") {
					continue
				}
				files = append(files, filepath.Join(msgDir, m.Name()))
				msgID := strings.TrimSuffix(m.Name(), ".json")
				files = append(files, regularFilesUnder(filepath.Join(storage, "part", msgID))...)
			}
		}
		mod := newestMtime(files)
		if info.Time.Updated > 0 {
			mod = time.UnixMilli(int64(info.Time.Updated))
		}
		// Archive paths are stored relative to home; a data dir outside home
		// (custom XDG_DATA_HOME) can't be represented portably, so skip it.
		if rel, err := filepath.Rel(home, path); err != nil || !filepath.IsLocal(rel) {
			return nil
		}
		out = append(out, LocalSession{
			Agent:     "opencode",
			SessionID: info.ID,
			Project:   info.Directory,
			Base:      "home",
			BaseDir:   home,
			Files:     files,
			Title:     cleanTitle(info.Title),
			ModTime:   mod,
		})
		return nil
	})
	return out, nil
}
