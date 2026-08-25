package agents

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
)

// gemini detects Gemini CLI session state: ~/.gemini/tmp/<sha256(cwd)>/
// holding logs.json, saved chats and checkpoints. One session per project
// hash (Gemini CLI keeps a single rolling history per project).
type gemini struct{}

func (gemini) Name() string { return "gemini" }

// GeminiProjectHash returns Gemini CLI's directory name for a project path.
func GeminiProjectHash(p string) string {
	h := sha256.Sum256([]byte(p))
	return hex.EncodeToString(h[:])
}

func (gemini) Detect(home, project string) ([]LocalSession, error) {
	root := filepath.Join(home, ".gemini", "tmp")
	dirs, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	wantDir := ""
	if project != "" {
		wantDir = GeminiProjectHash(project)
	}
	var out []LocalSession
	for _, d := range dirs {
		if !d.IsDir() || (wantDir != "" && d.Name() != wantDir) {
			continue
		}
		dir := filepath.Join(root, d.Name())
		files := regularFilesUnder(dir)
		if len(files) == 0 {
			continue
		}
		out = append(out, LocalSession{
			Agent:     "gemini",
			SessionID: d.Name()[:min(12, len(d.Name()))],
			Project:   project, // hash is one-way; only known when filtering by project
			Base:      "home",
			BaseDir:   home,
			Files:     files,
			Title:     geminiTitle(filepath.Join(dir, "logs.json")),
			ModTime:   newestMtime(files),
		})
	}
	return out, nil
}

func geminiTitle(logsPath string) string {
	data, err := os.ReadFile(logsPath)
	if err != nil || len(data) > 32*1024*1024 {
		return ""
	}
	var entries []map[string]any
	if err := json.Unmarshal(data, &entries); err != nil {
		return ""
	}
	// Last user message: the most recent thing the developer asked about.
	for i := len(entries) - 1; i >= 0; i-- {
		if entries[i]["type"] == "user" {
			if m, ok := entries[i]["message"].(string); ok {
				if t := cleanTitle(m); t != "" {
					return t
				}
			}
		}
	}
	return ""
}

func regularFilesUnder(dir string) []string {
	var files []string
	filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			files = append(files, path)
		}
		return nil
	})
	return files
}
