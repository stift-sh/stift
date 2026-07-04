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

// TokenInfo describes an access token (the secret itself is never stored).
type TokenInfo struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Admin     bool      `json:"admin"`
	CreatedAt time.Time `json:"created_at"`
}

// TokenCreated is returned by POST /v1/tokens; Token is shown exactly once.
type TokenCreated struct {
	TokenInfo
	Token string `json:"token"`
}

// Whoami is returned by GET /v1/whoami.
type Whoami struct {
	Name  string `json:"name"`
	Admin bool   `json:"admin"`
}

// Error is the JSON error envelope.
type Error struct {
	Error string `json:"error"`
}
