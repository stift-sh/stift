package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"stift/internal/api"
)

// Store keeps sessions on disk: data/sessions/<id>.json (metadata) next to
// data/sessions/<id>.tar.gz (archive), with an in-memory index on top.
type Store struct {
	dir   string
	mu    sync.RWMutex
	byID  map[string]*api.Session
	byKey map[string]string // session key -> id
}

func OpenStore(dataDir string) (*Store, error) {
	dir := filepath.Join(dataDir, "sessions")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, byID: map[string]*api.Session{}, byKey: map[string]string{}}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
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
		s.byID[sess.ID] = &sess
		s.byKey[sess.Key] = sess.ID
	}
	return s, nil
}

func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// Put stores an uploaded archive under the session's key. A key seen before
// with identical content is a no-op ("unchanged"); with different content it
// replaces the previous upload in place ("updated").
func (s *Store) Put(meta api.Session, archive io.Reader) (api.Session, string, error) {
	tmp, err := os.CreateTemp(s.dir, ".upload-*")
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

	now := time.Now().UTC()
	status := "created"
	if existingID, ok := s.byKey[meta.Key]; ok {
		existing := s.byID[existingID]
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

	if err := os.Rename(tmp.Name(), s.blobPath(meta.ID)); err != nil {
		return api.Session{}, "", err
	}
	if err := s.writeMeta(&meta); err != nil {
		return api.Session{}, "", err
	}
	s.byID[meta.ID] = &meta
	s.byKey[meta.Key] = meta.ID
	return meta, status, nil
}

func (s *Store) writeMeta(meta *api.Session) error {
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.metaPath(meta.ID) + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.metaPath(meta.ID))
}

func (s *Store) metaPath(id string) string { return filepath.Join(s.dir, id+".json") }
func (s *Store) blobPath(id string) string { return filepath.Join(s.dir, id+".tar.gz") }

func (s *Store) Get(id string) (api.Session, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if sess, ok := s.byID[id]; ok {
		return *sess, true
	}
	return api.Session{}, false
}

// OpenArchive returns a reader over the stored archive for id.
func (s *Store) OpenArchive(id string) (io.ReadSeekCloser, api.Session, error) {
	meta, ok := s.Get(id)
	if !ok {
		return nil, api.Session{}, os.ErrNotExist
	}
	f, err := os.Open(s.blobPath(id))
	return f, meta, err
}

func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.byID[id]
	if !ok {
		return os.ErrNotExist
	}
	if err := os.Remove(s.metaPath(id)); err != nil && !os.IsNotExist(err) {
		return err
	}
	os.Remove(s.blobPath(id))
	delete(s.byKey, sess.Key)
	delete(s.byID, id)
	return nil
}

// ListFilter narrows List results; zero value matches everything.
type ListFilter struct {
	Agent   string
	Project string
	Host    string
	Query   string // substring match on title, project and session id
}

func (s *Store) List(f ListFilter) []api.Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []api.Session{}
	for _, sess := range s.byID {
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

// ResolveID accepts a full or unambiguous-prefix session id.
func (s *Store) ResolveID(prefix string) (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, ok := s.byID[prefix]; ok {
		return prefix, nil
	}
	var match string
	for id := range s.byID {
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
