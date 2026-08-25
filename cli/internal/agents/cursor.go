package agents

import (
	"crypto/md5"
	"encoding/hex"
	"os"
	"path/filepath"
)

// cursor detects Cursor CLI agent sessions:
// ~/.cursor/chats/<md5(cwd)>/<session-uuid>/store.db (SQLite).
type cursor struct{}

func (cursor) Name() string { return "cursor" }

// CursorProjectHash returns Cursor CLI's chat directory name for a project path.
func CursorProjectHash(p string) string {
	h := md5.Sum([]byte(p))
	return hex.EncodeToString(h[:])
}

func (cursor) Detect(home, project string) ([]LocalSession, error) {
	root := filepath.Join(home, ".cursor", "chats")
	dirs, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	wantDir := ""
	if project != "" {
		wantDir = CursorProjectHash(project)
	}
	var out []LocalSession
	for _, d := range dirs {
		if !d.IsDir() || (wantDir != "" && d.Name() != wantDir) {
			continue
		}
		hashDir := filepath.Join(root, d.Name())
		sessions, err := os.ReadDir(hashDir)
		if err != nil {
			continue
		}
		for _, s := range sessions {
			if !s.IsDir() {
				continue
			}
			files := regularFilesUnder(filepath.Join(hashDir, s.Name()))
			if len(files) == 0 {
				continue
			}
			out = append(out, LocalSession{
				Agent:     "cursor",
				SessionID: s.Name(),
				Project:   project, // md5 is one-way; only known when filtering by project
				Base:      "home",
				BaseDir:   home,
				Files:     files,
				ModTime:   newestMtime(files),
			})
		}
	}
	return out, nil
}
