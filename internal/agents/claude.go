package agents

import (
	"os"
	"path/filepath"
	"strings"
)

// claude detects Claude Code sessions: ~/.claude/projects/<munged-cwd>/<uuid>.jsonl
// plus matching todo files under ~/.claude/todos/.
type claude struct{}

func (claude) Name() string { return "claude" }

// MungeClaudePath converts a project path to Claude Code's directory name
// for it (every non-alphanumeric character becomes '-').
func MungeClaudePath(p string) string {
	return strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			return r
		}
		return '-'
	}, p)
}

func (claude) Detect(home, project string) ([]LocalSession, error) {
	root := filepath.Join(home, ".claude", "projects")
	dirs, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	wantDir := ""
	if project != "" {
		wantDir = MungeClaudePath(project)
	}
	var out []LocalSession
	for _, d := range dirs {
		if !d.IsDir() || (wantDir != "" && d.Name() != wantDir) {
			continue
		}
		projDir := filepath.Join(root, d.Name())
		entries, err := os.ReadDir(projDir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
				continue
			}
			id := strings.TrimSuffix(e.Name(), ".jsonl")
			path := filepath.Join(projDir, e.Name())
			cwd, title := scanClaudeSession(path)
			if cwd == "" && project != "" {
				cwd = project
			}
			files := []string{path}
			todos, _ := filepath.Glob(filepath.Join(home, ".claude", "todos", id+"*.json"))
			files = append(files, todos...)
			out = append(out, LocalSession{
				Agent:     "claude",
				SessionID: id,
				Project:   cwd,
				Base:      "home",
				BaseDir:   home,
				Files:     files,
				Title:     title,
				ModTime:   newestMtime(files),
			})
		}
	}
	return out, nil
}

// scanClaudeSession pulls the working directory and a title (the session
// summary if present, otherwise the first real user message) out of a
// Claude Code session transcript.
func scanClaudeSession(path string) (cwd, title string) {
	var summary, firstUser string
	scanJSONLines(path, 100, func(obj map[string]any) bool {
		if c, ok := obj["cwd"].(string); ok && cwd == "" {
			cwd = c
		}
		switch obj["type"] {
		case "summary":
			if s, ok := obj["summary"].(string); ok && summary == "" {
				summary = s
			}
		case "user":
			if firstUser == "" {
				if msg, ok := obj["message"].(map[string]any); ok {
					firstUser = cleanTitle(textFromContent(msg["content"]))
				}
			}
		}
		return !(cwd != "" && (summary != "" || firstUser != ""))
	})
	title = summary
	if title == "" {
		title = firstUser
	}
	return cwd, cleanTitle(title)
}
