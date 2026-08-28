// Package api defines the wire types shared by the stift server and client.
package api

import "time"

// Session is the server-side record of one uploaded agent session.
type Session struct {
	ID        string    `json:"id"`
	Key       string    `json:"key"`
	Agent     string    `json:"agent"`
	SessionID string    `json:"session_id"`
	Project   string    `json:"project,omitempty"`
	ProjectID string    `json:"project_id,omitempty"` // repo name, for cross-machine matching
	Repo      string    `json:"repo,omitempty"`       // normalized git remote URL (secondary signal)
	Host      string    `json:"host"`
	Title     string    `json:"title,omitempty"`
	Base      string    `json:"base"` // "home" or "project": what archive paths are relative to
	Files     int       `json:"files"`
	Size      int64     `json:"size"`
	SHA256    string    `json:"sha256"`
	ModTime   time.Time `json:"mod_time"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// PushResult is returned by POST /v1/sessions.
type PushResult struct {
	Session Session `json:"session"`
	Status  string  `json:"status"` // "created", "updated" or "unchanged"
}

// UserRef is a user as referenced from other resources.
type UserRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// OrgRef is the caller's org as returned by whoami.
type OrgRef struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
	Name string `json:"name"`
}

// TokenInfo describes an access token (the secret itself is never stored).
type TokenInfo struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Admin     bool      `json:"admin"`
	CreatedAt time.Time `json:"created_at"`
	// LastUsedAt is nil until the token authenticates a request.
	LastUsedAt *time.Time `json:"last_used_at"`
	// User owns the token; nil from servers older than roles.
	User *UserRef `json:"user,omitempty"`
}

// TokenCreated is returned by POST /v1/tokens; Token is shown exactly once.
type TokenCreated struct {
	TokenInfo
	Token string `json:"token"`
}

// Whoami is returned by GET /v1/whoami. Role, User and Org are nil from
// servers older than roles; Admin is always set.
type Whoami struct {
	Name  string   `json:"name"`
	Admin bool     `json:"admin"`
	Role  *string  `json:"role,omitempty"`
	User  *UserRef `json:"user,omitempty"`
	Org   *OrgRef  `json:"org,omitempty"`
}

// Error is the JSON error envelope.
type Error struct {
	Error string `json:"error"`
}

// Bundle is one versioned manifest of a single *unit* of agent configuration
// (one skill, one subagent, one command file, a CLAUDE.md, ...) identified by
// (scope, agent, project?, name). Name is the unit's path relative to the
// agent's config root, e.g. "skills/deploy-checklist", "agents/reviewer",
// "commands/fix-tests" or "CLAUDE.md"; file paths in the manifest are
// relative to the unit (a skill's SKILL.md is at path "SKILL.md"). File
// contents live in content-addressed blobs referenced by SHA256.
type Bundle struct {
	Scope   string       `json:"scope"` // user|project|org
	Agent   string       `json:"agent"`
	Project string       `json:"project,omitempty"` // abs path (scope=project)
	Name    string       `json:"name"`              // unit name, 1-3 clean path segments
	Version int          `json:"version"`
	Parent  int          `json:"parent"` // version this was based on
	Host    string       `json:"host"`
	Author  string       `json:"author"` // Identity.Name
	Created time.Time    `json:"created"`
	Files   []BundleFile `json:"files"`
	Skills  []SkillMeta  `json:"skills"` // parsed SKILL.md frontmatter, for listing
}

// BundleFile is one file entry in a Bundle manifest.
type BundleFile struct {
	Path   string `json:"path"` // relative, forward slashes, no ".." / abs
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
	Mode   uint32 `json:"mode"` // only the exec bit is honoured
}

// SkillMeta is the frontmatter summary of one SKILL.md inside a bundle.
type SkillMeta struct {
	Path        string `json:"path"`
	Name        string `json:"name"`
	Description string `json:"description"`
}
