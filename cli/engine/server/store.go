package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/stift-sh/stift/engine/api"
)

// ListFilter narrows List results; zero value matches everything.
type ListFilter struct {
	Agent   string
	Project string
	Host    string
	Query   string // substring match on title, project and session id
}

// Backend is the storage abstraction the HTTP server depends on. Every method
// is scoped to a tenant: self-hosted deployments always pass the empty tenant
// ("") and get a single flat namespace, while a hosted/multi-tenant build
// (e.g. an object-store backed implementation) isolates data per tenant.
type Backend interface {
	// Put stores an uploaded archive under the session's key. A key seen
	// before with identical content is a no-op ("unchanged"); with different
	// content it replaces the previous upload in place ("updated").
	Put(tenant string, meta api.Session, archive io.Reader) (api.Session, string, error)
	Get(tenant, id string) (api.Session, bool)
	// OpenArchive returns a reader over the stored archive for id.
	OpenArchive(tenant, id string) (io.ReadSeekCloser, api.Session, error)
	Delete(tenant, id string) error
	List(tenant string, f ListFilter) []api.Session
	// ResolveID accepts a full or unambiguous-prefix session id.
	ResolveID(tenant, prefix string) (string, error)

	// HasBlobs reports which of the given sha256 hex digests are not stored.
	HasBlobs(tenant string, shas []string) (missing []string, err error)
	// PutBlob stores content under its sha256; the hash and size of r are
	// verified and the write is rejected on mismatch. Storing an existing blob
	// again is a no-op.
	PutBlob(tenant, sha string, r io.Reader, size int64) error
	OpenBlob(tenant, sha string) (io.ReadCloser, error)

	// PutBundle writes version HEAD+1 atomically. Returns ErrStale if
	// HEAD != b.Parent (unless force) and ErrMissingBlob if any referenced
	// blob is absent.
	PutBundle(tenant string, k BundleKey, b api.Bundle, force bool) (api.Bundle, error)
	// GetBundle returns one manifest version; version 0 means HEAD.
	GetBundle(tenant string, k BundleKey, version int) (api.Bundle, bool)
	// ListBundles returns the HEAD manifest of every bundle matching f.
	ListBundles(tenant string, f BundleFilter) []api.Bundle
	// BundleHistory returns every version, newest first.
	BundleHistory(tenant string, k BundleKey) []api.Bundle
	DeleteBundle(tenant string, k BundleKey) error
}

// BundleKey identifies one bundle (one config unit) within a tenant. Name is
// the unit's path relative to the agent's config root (1-3 clean segments).
type BundleKey struct{ Scope, Agent, Project, Name string }

// BundleFilter narrows ListBundles; zero value matches everything.
type BundleFilter struct{ Scope, Agent, Project, Name string }

var (
	// ErrStale is returned by PutBundle when the bundle's Parent is not the
	// current HEAD; the HTTP layer maps it to 409.
	ErrStale = errors.New("bundle is stale: parent is not the current head")
	// ErrMissingBlob is returned by PutBundle when a referenced blob has not
	// been uploaded; the HTTP layer maps it to 412.
	ErrMissingBlob = errors.New("bundle references a missing blob")
)

// scope is the in-memory index for a single tenant.
type scope struct {
	dir   string
	byID  map[string]*api.Session
	byKey map[string]string // session key -> id
}

// DiskStore keeps sessions on disk: <tenant dir>/<id>.json (metadata) next to
// <tenant dir>/<id>.tar.gz (archive), with an in-memory index on top. The empty
// tenant lives directly under data/sessions; named tenants live under
// data/sessions/t_<tenant>. It implements Backend.
type DiskStore struct {
	root   string
	mu     sync.RWMutex
	scopes map[string]*scope

	dataDir string
	bmu     sync.Mutex
	heads   map[string]map[BundleKey]*api.Bundle // tenant -> key -> HEAD manifest
}

// OpenStore opens (creating if needed) the on-disk session store rooted at
// dataDir, loading any existing sessions into memory.
func OpenStore(dataDir string) (*DiskStore, error) {
	root := filepath.Join(dataDir, "sessions")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	s := &DiskStore{root: root, scopes: map[string]*scope{}, dataDir: dataDir, heads: map[string]map[BundleKey]*api.Bundle{}}
	if err := s.loadBundles(); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	// Load the default ("") tenant from files directly under root, and each
	// named tenant from its t_<tenant> subdirectory.
	if err := s.loadScope("", root); err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), "t_") {
			tenant := e.Name()[len("t_"):]
			if err := s.loadScope(tenant, filepath.Join(root, e.Name())); err != nil {
				return nil, err
			}
		}
	}
	return s, nil
}

func (s *DiskStore) loadScope(tenant, dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	sc := &scope{dir: dir, byID: map[string]*api.Session{}, byKey: map[string]string{}}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var sess api.Session
		if json.Unmarshal(data, &sess) != nil || sess.ID == "" {
			continue
		}
		sc.byID[sess.ID] = &sess
		sc.byKey[sess.Key] = sess.ID
	}
	s.scopes[tenant] = sc
	return nil
}

func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// ValidTenant guards tenant names used as on-disk path segments against
// traversal and separators.
func ValidTenant(tenant string) bool {
	if tenant == "" {
		return true
	}
	for _, r := range tenant {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

func (s *DiskStore) tenantDir(tenant string) string {
	if tenant == "" {
		return s.root
	}
	return filepath.Join(s.root, "t_"+tenant)
}

// scopeLocked returns the tenant's scope, creating an empty one if needed. The
// caller must hold s.mu (write lock).
func (s *DiskStore) scopeLocked(tenant string) *scope {
	if sc, ok := s.scopes[tenant]; ok {
		return sc
	}
	sc := &scope{dir: s.tenantDir(tenant), byID: map[string]*api.Session{}, byKey: map[string]string{}}
	s.scopes[tenant] = sc
	return sc
}

func (s *DiskStore) Put(tenant string, meta api.Session, archive io.Reader) (api.Session, string, error) {
	if !ValidTenant(tenant) {
		return api.Session{}, "", fmt.Errorf("invalid tenant %q", tenant)
	}
	dir := s.tenantDir(tenant)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return api.Session{}, "", err
	}
	tmp, err := os.CreateTemp(dir, ".upload-*")
	if err != nil {
		return api.Session{}, "", err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	size, err := io.Copy(io.MultiWriter(tmp, h), archive)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return api.Session{}, "", err
	}
	sum := hex.EncodeToString(h.Sum(nil))

	s.mu.Lock()
	defer s.mu.Unlock()
	sc := s.scopeLocked(tenant)

	now := time.Now().UTC()
	status := "created"
	if existingID, ok := sc.byKey[meta.Key]; ok {
		existing := sc.byID[existingID]
		if existing.SHA256 == sum {
			return *existing, "unchanged", nil
		}
		status = "updated"
		meta.ID = existing.ID
		meta.CreatedAt = existing.CreatedAt
	} else {
		meta.ID = newID()
		meta.CreatedAt = now
	}
	meta.SHA256 = sum
	meta.Size = size
	meta.UpdatedAt = now

	if err := os.Rename(tmp.Name(), blobPath(dir, meta.ID)); err != nil {
		return api.Session{}, "", err
	}
	if err := writeMeta(dir, &meta); err != nil {
		return api.Session{}, "", err
	}
	sc.byID[meta.ID] = &meta
	sc.byKey[meta.Key] = meta.ID
	return meta, status, nil
}

func writeMeta(dir string, meta *api.Session) error {
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	tmp := metaPath(dir, meta.ID) + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, metaPath(dir, meta.ID))
}

func metaPath(dir, id string) string { return filepath.Join(dir, id+".json") }
func blobPath(dir, id string) string { return filepath.Join(dir, id+".tar.gz") }

func (s *DiskStore) Get(tenant, id string) (api.Session, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if sc, ok := s.scopes[tenant]; ok {
		if sess, ok := sc.byID[id]; ok {
			return *sess, true
		}
	}
	return api.Session{}, false
}

func (s *DiskStore) OpenArchive(tenant, id string) (io.ReadSeekCloser, api.Session, error) {
	meta, ok := s.Get(tenant, id)
	if !ok {
		return nil, api.Session{}, os.ErrNotExist
	}
	f, err := os.Open(blobPath(s.tenantDir(tenant), id))
	return f, meta, err
}

func (s *DiskStore) Delete(tenant, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	sc, ok := s.scopes[tenant]
	if !ok {
		return os.ErrNotExist
	}
	sess, ok := sc.byID[id]
	if !ok {
		return os.ErrNotExist
	}
	if err := os.Remove(metaPath(sc.dir, id)); err != nil && !os.IsNotExist(err) {
		return err
	}
	os.Remove(blobPath(sc.dir, id))
	delete(sc.byKey, sess.Key)
	delete(sc.byID, id)
	return nil
}

func (s *DiskStore) List(tenant string, f ListFilter) []api.Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []api.Session{}
	sc, ok := s.scopes[tenant]
	if !ok {
		return out
	}
	for _, sess := range sc.byID {
		if f.Agent != "" && sess.Agent != f.Agent {
			continue
		}
		if f.Project != "" && sess.Project != f.Project {
			continue
		}
		if f.Host != "" && sess.Host != f.Host {
			continue
		}
		if f.Query != "" {
			q := strings.ToLower(f.Query)
			hay := strings.ToLower(sess.Title + " " + sess.Project + " " + sess.SessionID)
			if !strings.Contains(hay, q) {
				continue
			}
		}
		out = append(out, *sess)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out
}

func (s *DiskStore) ResolveID(tenant, prefix string) (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sc, ok := s.scopes[tenant]
	if !ok {
		return "", os.ErrNotExist
	}
	if _, ok := sc.byID[prefix]; ok {
		return prefix, nil
	}
	var match string
	for id := range sc.byID {
		if strings.HasPrefix(id, prefix) {
			if match != "" {
				return "", fmt.Errorf("ambiguous id prefix %q", prefix)
			}
			match = id
		}
	}
	if match == "" {
		return "", os.ErrNotExist
	}
	return match, nil
}

// compile-time check that DiskStore satisfies Backend.
var _ Backend = (*DiskStore)(nil)
