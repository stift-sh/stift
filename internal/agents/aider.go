package agents

import (
	"os"
	"path/filepath"
)

// aider detects aider history files, which live inside the project
// directory itself (.aider.chat.history.md, .aider.input.history).
// aider appends every session to the same files, so there is one
// logical session per project, identified as "history".
type aider struct{}

func (aider) Name() string { return "aider" }

func (aider) Detect(home, project string) ([]LocalSession, error) {
	if project == "" {
		return nil, nil // aider files are per-project; nothing to scan globally
	}
	var files []string
	for _, name := range []string{".aider.chat.history.md", ".aider.input.history"} {
		p := filepath.Join(project, name)
		if info, err := os.Stat(p); err == nil && info.Mode().IsRegular() {
			files = append(files, p)
		}
	}
	if len(files) == 0 {
		return nil, nil
	}
	return []LocalSession{{
		Agent:     "aider",
		SessionID: "history",
		Project:   project,
		Base:      "project",
		BaseDir:   project,
		Files:     files,
		ModTime:   newestMtime(files),
	}}, nil
}
