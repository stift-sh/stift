// Package agents detects sessions stored locally by AI coding agents.
package agents

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
)

// LocalSession is one agent session found on this machine.
type LocalSession struct {
	Agent     string
	SessionID string
	Project   string // absolute project path if known, "" otherwise
	Base      string // "home" or "project": what Files are relative to
	BaseDir   string // the directory Files live under
	Files     []string
	Title     string
	ModTime   time.Time
}

// Key identifies a session for server-side deduplication: re-pushing the
// same session from the same machine updates the existing record.
func (s LocalSession) Key(host string) string {
	proj := s.Project
	if proj == "" {
		proj = "-"
	}
	return strings.Join([]string{s.Agent, host, proj, s.SessionID}, "|")
}

// Detector finds sessions for one agent. project filters to a single
// project directory; pass "" to detect sessions for all projects.
type Detector interface {
	Name() string
	Detect(home, project string) ([]LocalSession, error)
}

// All built-in agent detectors.
var All = []Detector{claude{}, codex{}, gemini{}, cursor{}, opencode{}, aider{}}

// Names returns the names of every available detector, built-in and custom.
func Names() []string {
	detectors, _ := LoadCustom()
	var n []string
	for _, d := range append(append([]Detector{}, All...), detectors...) {
		n = append(n, d.Name())
	}
	return n
}

// Detect runs the named detectors (all of them when names is empty),
// built-in and custom alike, and returns every session found, newest first.
// Detector errors are collected as warnings rather than aborting the scan.
func Detect(names []string, home, project string) ([]LocalSession, []string) {
	want := map[string]bool{}
	for _, n := range names {
		want[strings.ToLower(strings.TrimSpace(n))] = true
	}
	custom, warnings := LoadCustom()
	var out []LocalSession
	for _, d := range append(append([]Detector{}, All...), custom...) {
		if len(want) > 0 && !want[d.Name()] {
			continue
		}
		ss, err := d.Detect(home, project)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("%s: %v", d.Name(), err))
			continue
		}
		out = append(out, ss...)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ModTime.After(out[j].ModTime) })
	return out, warnings
}

// scanJSONLines calls fn with each parsed JSON object from a .json or
// .jsonl file, up to maxLines lines, stopping early when fn returns false.
// Oversized or malformed lines are skipped silently.
func scanJSONLines(path string, maxLines int, fn func(map[string]any) bool) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 32*1024*1024)
	for i := 0; i < maxLines && sc.Scan(); i++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var obj map[string]any
		if err := json.Unmarshal([]byte(line), &obj); err != nil {
			continue
		}
		if !fn(obj) {
			return nil
		}
	}
	return nil
}

// firstUserText extracts a human-readable snippet from message content that
// is either a plain string or a list of {type:"text"/"input_text", text} blocks.
func textFromContent(content any) string {
	switch c := content.(type) {
	case string:
		return c
	case []any:
		for _, item := range c {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if t, ok := m["text"].(string); ok && t != "" {
				return t
			}
		}
	}
	return ""
}

// cleanTitle trims a candidate session title down to one short line.
func cleanTitle(s string) string {
	s = strings.TrimSpace(s)
	if s == "" || strings.HasPrefix(s, "<") || strings.HasPrefix(s, "Caveat:") {
		return ""
	}
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		s = s[:i]
	}
	r := []rune(s)
	if len(r) > 80 {
		s = string(r[:79]) + "…"
	}
	return s
}

func newestMtime(paths []string) time.Time {
	var t time.Time
	for _, p := range paths {
		if info, err := os.Stat(p); err == nil && info.ModTime().After(t) {
			t = info.ModTime()
		}
	}
	return t
}
