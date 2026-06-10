package agents

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Custom is a user-defined agent from ~/.config/stift/agents.json
// (override the location with STIFT_AGENTS). Each entry needs a name and a
// glob pattern; every match becomes one session (a matched file is a
// single-file session, a matched directory is a session of all files under it).
//
// Patterns starting with "~/" are home-based; anything else is resolved
// against the project directory. Home-based patterns may embed how the agent
// encodes the project path in its directory layout:
//
//	{sha256}   sha256 hex of the project path (Gemini-style)
//	{md5}      md5 hex of the project path (Cursor-style)
//	{munged}   path with non-alphanumerics replaced by '-' (Claude-style)
//	{basename} last path element of the project
//
// With a placeholder, project filtering works like the built-ins; without
// one, home-based sessions are treated as machine-global and detected on
// every push.
type Custom struct {
	AgentName string `json:"name"`
	Sessions  string `json:"sessions"`
}

func (c Custom) Name() string { return c.AgentName }

var (
	customNameRe  = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	placeholderRe = regexp.MustCompile(`\{(sha256|md5|munged|basename)\}`)
)

// CustomConfigPath returns the custom agent config location.
func CustomConfigPath() string {
	if p := os.Getenv("STIFT_AGENTS"); p != "" {
		return p
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "stift", "agents.json")
}

// LoadCustom reads the custom agent definitions. Invalid entries are
// reported as warnings and skipped rather than aborting detection.
func LoadCustom() ([]Detector, []string) {
	path := CustomConfigPath()
	if path == "" {
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, []string{fmt.Sprintf("custom agents: %v", err)}
	}
	var defs []Custom
	if err := json.Unmarshal(data, &defs); err != nil {
		return nil, []string{fmt.Sprintf("custom agents: parse %s: %v", path, err)}
	}
	builtin := map[string]bool{}
	for _, d := range All {
		builtin[d.Name()] = true
	}
	var out []Detector
	var warnings []string
	seen := map[string]bool{}
	for i, def := range defs {
		switch {
		case !customNameRe.MatchString(def.AgentName):
			warnings = append(warnings, fmt.Sprintf(
				"custom agents: entry %d: name %q must be lowercase letters, digits and dashes", i, def.AgentName))
		case builtin[def.AgentName]:
			warnings = append(warnings, fmt.Sprintf(
				"custom agents: %q overrides a built-in agent name; entry skipped", def.AgentName))
		case seen[def.AgentName]:
			warnings = append(warnings, fmt.Sprintf("custom agents: duplicate name %q; entry skipped", def.AgentName))
		case def.Sessions == "":
			warnings = append(warnings, fmt.Sprintf("custom agents: %q: sessions pattern is required", def.AgentName))
		case filepath.IsAbs(def.Sessions):
			warnings = append(warnings, fmt.Sprintf(
				"custom agents: %q: sessions must start with ~/ or be a project-relative path", def.AgentName))
		default:
			seen[def.AgentName] = true
			out = append(out, def)
		}
	}
	return out, warnings
}

func (c Custom) Detect(home, project string) ([]LocalSession, error) {
	pattern := c.Sessions
	base, baseDir := "home", home
	if strings.HasPrefix(pattern, "~/") {
		pattern = filepath.Join(home, pattern[2:])
	} else {
		if project == "" {
			return nil, nil // project-relative patterns need a project
		}
		base, baseDir = "project", project
		pattern = filepath.Join(project, pattern)
	}

	sessProject := project
	if placeholderRe.MatchString(pattern) {
		if project != "" {
			pattern = placeholderRe.ReplaceAllStringFunc(pattern, func(m string) string {
				switch m {
				case "{sha256}":
					return GeminiProjectHash(project)
				case "{md5}":
					return CursorProjectHash(project)
				case "{munged}":
					return MungeClaudePath(project)
				default: // {basename}
					return filepath.Base(project)
				}
			})
		} else {
			pattern = placeholderRe.ReplaceAllString(pattern, "*")
		}
	} else if base == "home" {
		// No project encoding in the pattern: these sessions are
		// machine-global, detected regardless of the project filter.
		sessProject = ""
	}

	matches, err := filepath.Glob(pattern)
	if err != nil {
		return nil, fmt.Errorf("invalid sessions pattern %q: %w", c.Sessions, err)
	}
	var out []LocalSession
	for _, m := range matches {
		rel, err := filepath.Rel(baseDir, m)
		if err != nil || !filepath.IsLocal(rel) {
			continue // never archive anything outside the base directory
		}
		info, err := os.Stat(m)
		if err != nil {
			continue
		}
		var files []string
		switch {
		case info.IsDir():
			if files = regularFilesUnder(m); len(files) == 0 {
				continue
			}
		case info.Mode().IsRegular():
			files = []string{m}
		default:
			continue
		}
		out = append(out, LocalSession{
			Agent:     c.AgentName,
			SessionID: c.sessionID(rel, info.IsDir()),
			Project:   sessProject,
			Base:      base,
			BaseDir:   baseDir,
			Files:     files,
			ModTime:   newestMtime(files),
		})
	}
	return out, nil
}

// sessionID derives a stable id for a match. For simple patterns (wildcards
// only in the last path segment) the file/directory name is enough. When the
// pattern matches across directories (a wildcard or placeholder before the
// last segment), names alone could collide between directories, so the id is
// built from the whole relative path instead — the rule depends only on the
// pattern, keeping ids identical between filtered and all-project scans.
func (c Custom) sessionID(rel string, isDir bool) string {
	name := filepath.Base(rel)
	if !isDir {
		name = strings.TrimSuffix(name, filepath.Ext(name))
	}
	dir := ""
	if i := strings.LastIndexByte(c.Sessions, '/'); i >= 0 {
		dir = c.Sessions[:i]
	}
	if !strings.ContainsAny(dir, "*?[{") {
		return name
	}
	if !isDir {
		rel = strings.TrimSuffix(rel, filepath.Ext(rel))
	}
	return strings.Trim(MungeClaudePath(filepath.ToSlash(rel)), "-")
}
