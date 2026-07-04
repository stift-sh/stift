// Package gitrepo derives a stable, cross-machine project identity from a
// directory's git remote, falling back to the directory name.
package gitrepo

import (
	"os/exec"
	"path/filepath"
	"strings"
)

// RemoteURL returns the normalized origin remote for dir, if dir is inside a
// git repository with an "origin" remote. The result is host + path with any
// credentials, scheme, ".git" suffix and trailing slash removed, e.g.
// "github.com/acme/myapp". The second return is false when there is no remote.
func RemoteURL(dir string) (string, bool) {
	out, err := exec.Command("git", "-C", dir, "config", "--get", "remote.origin.url").Output()
	if err != nil {
		return "", false
	}
	raw := strings.TrimSpace(string(out))
	norm := normalizeRemote(raw)
	if norm == "" {
		return "", false
	}
	return norm, true
}

// Identity returns the cross-machine project id and normalized git remote for
// dir in a single git invocation. projectID is the remote's last path segment
// (e.g. "myapp"), or the directory's base name when there is no remote; repo
// is the normalized remote URL, empty when there is none. projectID is "" only
// for an empty dir.
func Identity(dir string) (projectID, repo string) {
	if remote, ok := RemoteURL(dir); ok {
		if i := strings.LastIndex(remote, "/"); i >= 0 && i < len(remote)-1 {
			return remote[i+1:], remote
		}
		return remote, remote
	}
	if dir == "" {
		return "", ""
	}
	return filepath.Base(dir), ""
}

// ProjectID is the cross-machine identity for the project at dir: the last
// path segment of the git remote (e.g. "myapp"), or the directory's base name
// when there is no remote. Returns "" only for an empty dir.
func ProjectID(dir string) string {
	id, _ := Identity(dir)
	return id
}

// normalizeRemote turns a git remote URL into a canonical "host/path" form.
// It handles both scp-style ("git@host:owner/repo.git") and URL-style
// ("https://user:pass@host/owner/repo.git") remotes.
func normalizeRemote(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	// scp-style: git@host:owner/repo(.git)
	if !strings.Contains(s, "://") {
		if at := strings.LastIndex(s, "@"); at >= 0 {
			s = s[at+1:]
		}
		s = strings.Replace(s, ":", "/", 1)
	} else {
		// URL-style: strip scheme, then credentials before the host.
		if i := strings.Index(s, "://"); i >= 0 {
			s = s[i+3:]
		}
		if at := strings.LastIndex(s, "@"); at >= 0 {
			s = s[at+1:]
		}
	}
	s = strings.TrimSuffix(s, "/")
	s = strings.TrimSuffix(s, ".git")
	// Lowercase the host component only; paths can be case-sensitive.
	if i := strings.Index(s, "/"); i > 0 {
		s = strings.ToLower(s[:i]) + s[i:]
	}
	return s
}
