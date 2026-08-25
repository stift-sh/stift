package agents

import (
	"io/fs"
	"path/filepath"
	"regexp"
	"strings"
)

// codex detects OpenAI Codex CLI sessions:
// ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
type codex struct{}

func (codex) Name() string { return "codex" }

var codexUUID = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)

func (codex) Detect(home, project string) ([]LocalSession, error) {
	root := filepath.Join(home, ".codex", "sessions")
	var out []LocalSession
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".jsonl") {
			return nil //nolint:nilerr // unreadable subtrees are skipped, not fatal
		}
		id, cwd, title := scanCodexSession(path)
		if id == "" {
			if m := codexUUID.FindString(d.Name()); m != "" {
				id = m
			} else {
				id = strings.TrimSuffix(d.Name(), ".jsonl")
			}
		}
		if project != "" && cwd != project {
			return nil
		}
		files := []string{path}
		out = append(out, LocalSession{
			Agent:     "codex",
			SessionID: id,
			Project:   cwd,
			Base:      "home",
			BaseDir:   home,
			Files:     files,
			Title:     title,
			ModTime:   newestMtime(files),
		})
		return nil
	})
	if err != nil {
		return out, nil
	}
	return out, nil
}

func scanCodexSession(path string) (id, cwd, title string) {
	scanJSONLines(path, 100, func(obj map[string]any) bool {
		payload, _ := obj["payload"].(map[string]any)
		switch obj["type"] {
		case "session_meta":
			if payload != nil {
				if v, ok := payload["id"].(string); ok {
					id = v
				}
				if v, ok := payload["cwd"].(string); ok {
					cwd = v
				}
			}
		case "event_msg":
			if payload != nil && payload["type"] == "user_message" && title == "" {
				if m, ok := payload["message"].(string); ok {
					title = cleanTitle(m)
				}
			}
		case "response_item":
			if payload != nil && payload["role"] == "user" && title == "" {
				title = cleanTitle(textFromContent(payload["content"]))
			}
		}
		// Older rollouts: a bare meta object on the first line.
		if id == "" {
			if v, ok := obj["id"].(string); ok {
				id = v
				if c, ok := obj["cwd"].(string); ok {
					cwd = c
				}
			}
		}
		return !(id != "" && cwd != "" && title != "")
	})
	return id, cwd, title
}
