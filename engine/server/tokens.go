package server

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/stift-sh/stift/engine/api"
)

// TokenPrefix marks stift access tokens so they are recognizable in
// configs and secret scanners.
const TokenPrefix = "stf_"

type tokenRecord struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Hash      string    `json:"hash"` // hex(sha256(raw token))
	Admin     bool      `json:"admin"`
	CreatedAt time.Time `json:"created_at"`
}

// Tokens is the on-disk token registry (data/tokens.json). Only hashes are
// stored; the raw token is shown once at creation time.
type Tokens struct {
	path string
	mu   sync.RWMutex
	list []tokenRecord
}

func OpenTokens(dataDir string) (*Tokens, error) {
	t := &Tokens{path: filepath.Join(dataDir, "tokens.json")}
	data, err := os.ReadFile(t.path)
	if err != nil {
		if os.IsNotExist(err) {
			return t, nil
		}
		return nil, err
	}
	return t, json.Unmarshal(data, &t.list)
}

func (t *Tokens) save() error {
	data, err := json.MarshalIndent(t.list, "", "  ")
	if err != nil {
		return err
	}
	tmp := t.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, t.path)
}

func hashToken(raw string) string {
	h := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(h[:])
}

func (t *Tokens) Empty() bool {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return len(t.list) == 0
}

// Create mints a new token and returns the raw secret (shown only once).
func (t *Tokens) Create(name string, admin bool) (string, api.TokenInfo, error) {
	b := make([]byte, 24)
	rand.Read(b)
	raw := TokenPrefix + hex.EncodeToString(b)
	info, err := t.Register(raw, name, admin)
	return raw, info, err
}

// Register adds a known raw token (e.g. from STIFT_ADMIN_TOKEN).
// Registering a token that already exists is a no-op.
func (t *Tokens) Register(raw, name string, admin bool) (api.TokenInfo, error) {
	hash := hashToken(raw)
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, r := range t.list {
		if r.Hash == hash {
			return api.TokenInfo{ID: r.ID, Name: r.Name, Admin: r.Admin, CreatedAt: r.CreatedAt}, nil
		}
	}
	idb := make([]byte, 4)
	rand.Read(idb)
	rec := tokenRecord{
		ID:        hex.EncodeToString(idb),
		Name:      name,
		Hash:      hash,
		Admin:     admin,
		CreatedAt: time.Now().UTC(),
	}
	t.list = append(t.list, rec)
	if err := t.save(); err != nil {
		t.list = t.list[:len(t.list)-1]
		return api.TokenInfo{}, err
	}
	return api.TokenInfo{ID: rec.ID, Name: rec.Name, Admin: rec.Admin, CreatedAt: rec.CreatedAt}, nil
}

// Check verifies a presented token and returns its record.
func (t *Tokens) Check(raw string) (api.TokenInfo, bool) {
	hash := hashToken(raw)
	t.mu.RLock()
	defer t.mu.RUnlock()
	for _, r := range t.list {
		if subtle.ConstantTimeCompare([]byte(r.Hash), []byte(hash)) == 1 {
			return api.TokenInfo{ID: r.ID, Name: r.Name, Admin: r.Admin, CreatedAt: r.CreatedAt}, true
		}
	}
	return api.TokenInfo{}, false
}

// Authenticate makes the local token registry usable as an Authenticator.
// It maps a verified token to the default ("") tenant: a self-hosted server is
// single-tenant.
func (t *Tokens) Authenticate(raw string) (Identity, bool) {
	info, ok := t.Check(raw)
	if !ok {
		return Identity{}, false
	}
	return Identity{ID: info.ID, Name: info.Name, Admin: info.Admin}, true
}

func (t *Tokens) List() []api.TokenInfo {
	t.mu.RLock()
	defer t.mu.RUnlock()
	out := []api.TokenInfo{}
	for _, r := range t.list {
		out = append(out, api.TokenInfo{ID: r.ID, Name: r.Name, Admin: r.Admin, CreatedAt: r.CreatedAt})
	}
	return out
}

func (t *Tokens) Revoke(id string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	for i, r := range t.list {
		if r.ID == id {
			t.list = append(t.list[:i], t.list[i+1:]...)
			return t.save()
		}
	}
	return os.ErrNotExist
}
