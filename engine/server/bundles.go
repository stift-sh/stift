package server

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/stift-sh/stift/engine/api"
)

// On-disk layout (relative to dataDir):
//
//	blobs/[t_<tenant>/]<sha[:2]>/<sha>
//	bundles/[t_<tenant>/]<scope>/<agent>[/<sha256(project)[:16]>]/<name...>/{HEAD,vN.json}
//
// Name segments become directories, so units nest under one another on disk
// ("skills" and "skills/a" are distinct units); HEAD loading walks the whole
// tree and every unit is identified by the manifest it stores, not its path.

func tenantPrefix(tenant string) string {
	if tenant == "" {
		return ""
	}
	return "t_" + tenant
}

func (s *DiskStore) blobsDir(tenant string) string {
	return filepath.Join(s.dataDir, "blobs", tenantPrefix(tenant))
}

func (s *DiskStore) bundlesDir(tenant string) string {
	return filepath.Join(s.dataDir, "bundles", tenantPrefix(tenant))
}

func (s *DiskStore) blobFile(tenant, sha string) string {
	return filepath.Join(s.blobsDir(tenant), sha[:2], sha)
}

func projectHash(project string) string {
	sum := sha256.Sum256([]byte(project))
	return hex.EncodeToString(sum[:])[:16]
}

func (s *DiskStore) bundleDir(tenant string, k BundleKey) string {
	dir := filepath.Join(s.bundlesDir(tenant), k.Scope, k.Agent)
	if k.Project != "" {
		dir = filepath.Join(dir, projectHash(k.Project))
	}
	return filepath.Join(dir, filepath.FromSlash(k.Name))
}

// MaxNameSegments bounds how deep a unit name may nest.
const MaxNameSegments = 3

// ValidUnitName reports whether name is an acceptable bundle unit name: a
// clean relative forward-slash path of 1 to MaxNameSegments segments using
// the same character rules as manifest file paths.
func ValidUnitName(name string) bool {
	if !ValidBundlePath(name) {
		return false
	}
	if n := strings.Count(name, "/") + 1; n > MaxNameSegments {
		return false
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// ValidSHA reports whether sha is a lowercase hex SHA-256 digest.
func ValidSHA(sha string) bool {
	if len(sha) != 64 {
		return false
	}
	for _, r := range sha {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}

// ValidSegment guards scope/agent names used as path segments.
func ValidSegment(seg string) bool {
	if seg == "" {
		return false
	}
	for _, r := range seg {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' || r == '.') {
			return false
		}
	}
	return seg != "." && seg != ".."
}

// ValidKey reports whether k names a storable bundle (scope, agent, project, unit name).
func ValidKey(k BundleKey) error {
	switch k.Scope {
	case "user", "project", "org":
	default:
		return fmt.Errorf("invalid scope %q", k.Scope)
	}
	if !ValidSegment(k.Agent) {
		return fmt.Errorf("invalid agent %q", k.Agent)
	}
	if (k.Scope == "project") != (k.Project != "") {
		return fmt.Errorf("project must be set exactly when scope=project")
	}
	if !ValidUnitName(k.Name) {
		return fmt.Errorf("invalid bundle name %q (want 1-%d clean path segments)", k.Name, MaxNameSegments)
	}
	return nil
}

// ValidBundlePath accepts clean, relative, forward-slash paths only.
func ValidBundlePath(p string) bool {
	if p == "" || strings.HasPrefix(p, "/") || strings.Contains(p, "\\") || strings.ContainsRune(p, 0) {
		return false
	}
	if strings.ContainsAny(p, "\n\r\t") {
		return false
	}
	if path.Clean(p) != p {
		return false
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	// Reject Windows drive-letter absolutes like "C:/x".
	if len(p) >= 2 && p[1] == ':' {
		return false
	}
	return true
}

// ---- blobs ----

func (s *DiskStore) HasBlobs(tenant string, shas []string) ([]string, error) {
	if !ValidTenant(tenant) {
		return nil, fmt.Errorf("invalid tenant %q", tenant)
	}
	missing := []string{}
	for _, sha := range shas {
		if !ValidSHA(sha) {
			return nil, fmt.Errorf("invalid sha256 %q", sha)
		}
		if _, err := os.Stat(s.blobFile(tenant, sha)); err != nil {
			missing = append(missing, sha)
		}
	}
	return missing, nil
}

func (s *DiskStore) PutBlob(tenant, sha string, r io.Reader, size int64) error {
	if !ValidTenant(tenant) {
		return fmt.Errorf("invalid tenant %q", tenant)
	}
	if !ValidSHA(sha) {
		return fmt.Errorf("invalid sha256 %q", sha)
	}
	dst := s.blobFile(tenant, sha)
	if _, err := os.Stat(dst); err == nil {
		// Already stored; content-addressed so nothing to do.
		io.Copy(io.Discard, r)
		return nil
	}
	dir := filepath.Dir(dst)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".blob-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), r)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if size >= 0 && n != size {
		return fmt.Errorf("blob size mismatch: got %d bytes, want %d", n, size)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != sha {
		return fmt.Errorf("blob hash mismatch: got %s, want %s", got, sha)
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), dst)
}

func (s *DiskStore) OpenBlob(tenant, sha string) (io.ReadCloser, error) {
	if !ValidTenant(tenant) || !ValidSHA(sha) {
		return nil, os.ErrNotExist
	}
	return os.Open(s.blobFile(tenant, sha))
}

// ---- bundles ----

func (s *DiskStore) loadBundles() error {
	root := filepath.Join(s.dataDir, "bundles")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	if err := s.loadBundleTenant("", root); err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), "t_") {
			if err := s.loadBundleTenant(e.Name()[2:], filepath.Join(root, e.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}

// loadBundleTenant walks <dir>/<scope>/<agent>[/<hash>]/<name...> and loads
// each HEAD it finds at any depth.
func (s *DiskStore) loadBundleTenant(tenant, dir string) error {
	return filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if tenant == "" && d.IsDir() && strings.HasPrefix(d.Name(), "t_") && filepath.Dir(p) == dir {
			return filepath.SkipDir // named tenant dir under the default tenant's root
		}
		if d.IsDir() || d.Name() != "HEAD" {
			return nil
		}
		b, ok := readHead(filepath.Dir(p))
		if !ok {
			return nil
		}
		k := BundleKey{Scope: b.Scope, Agent: b.Agent, Project: b.Project, Name: b.Name}
		if ValidKey(k) != nil {
			return nil
		}
		s.headsFor(tenant)[k] = &b
		return nil
	})
}

func readHead(dir string) (api.Bundle, bool) {
	data, err := os.ReadFile(filepath.Join(dir, "HEAD"))
	if err != nil {
		return api.Bundle{}, false
	}
	v, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || v <= 0 {
		return api.Bundle{}, false
	}
	return readVersion(dir, v)
}

func readVersion(dir string, v int) (api.Bundle, bool) {
	data, err := os.ReadFile(filepath.Join(dir, fmt.Sprintf("v%d.json", v)))
	if err != nil {
		return api.Bundle{}, false
	}
	var b api.Bundle
	if json.Unmarshal(data, &b) != nil {
		return api.Bundle{}, false
	}
	return b, true
}

// headsFor returns the tenant's HEAD map, creating it. Caller holds s.bmu
// (or is single-threaded during OpenStore).
func (s *DiskStore) headsFor(tenant string) map[BundleKey]*api.Bundle {
	m, ok := s.heads[tenant]
	if !ok {
		m = map[BundleKey]*api.Bundle{}
		s.heads[tenant] = m
	}
	return m
}

func (s *DiskStore) PutBundle(tenant string, k BundleKey, b api.Bundle, force bool) (api.Bundle, error) {
	if !ValidTenant(tenant) {
		return api.Bundle{}, fmt.Errorf("invalid tenant %q", tenant)
	}
	if err := ValidKey(k); err != nil {
		return api.Bundle{}, err
	}
	seen := map[string]bool{}
	for _, f := range b.Files {
		if !ValidBundlePath(f.Path) {
			return api.Bundle{}, fmt.Errorf("invalid file path %q", f.Path)
		}
		if seen[f.Path] {
			return api.Bundle{}, fmt.Errorf("duplicate file path %q", f.Path)
		}
		seen[f.Path] = true
		if !ValidSHA(f.SHA256) {
			return api.Bundle{}, fmt.Errorf("invalid sha256 %q for %s", f.SHA256, f.Path)
		}
	}
	shas := make([]string, 0, len(b.Files))
	for _, f := range b.Files {
		shas = append(shas, f.SHA256)
	}
	missing, err := s.HasBlobs(tenant, shas)
	if err != nil {
		return api.Bundle{}, err
	}
	if len(missing) > 0 {
		return api.Bundle{}, fmt.Errorf("%w: %s", ErrMissingBlob, strings.Join(missing, ", "))
	}
	skills, err := s.parseSkills(tenant, b.Files)
	if err != nil {
		return api.Bundle{}, err
	}

	s.bmu.Lock()
	defer s.bmu.Unlock()
	heads := s.headsFor(tenant)
	head := 0
	if cur, ok := heads[k]; ok {
		head = cur.Version
	}
	if !force && b.Parent != head {
		return api.Bundle{}, fmt.Errorf("%w (head=%d, parent=%d)", ErrStale, head, b.Parent)
	}

	b.Scope, b.Agent, b.Project, b.Name = k.Scope, k.Agent, k.Project, k.Name
	b.Version = head + 1
	b.Created = time.Now().UTC()
	b.Skills = skills
	if b.Files == nil {
		b.Files = []api.BundleFile{}
	}
	sort.Slice(b.Files, func(i, j int) bool { return b.Files[i].Path < b.Files[j].Path })

	dir := s.bundleDir(tenant, k)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return api.Bundle{}, err
	}
	data, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return api.Bundle{}, err
	}
	vpath := filepath.Join(dir, fmt.Sprintf("v%d.json", b.Version))
	if err := os.WriteFile(vpath+".tmp", data, 0o600); err != nil {
		return api.Bundle{}, err
	}
	if err := os.Rename(vpath+".tmp", vpath); err != nil {
		return api.Bundle{}, err
	}
	headTmp := filepath.Join(dir, "HEAD.tmp")
	if err := os.WriteFile(headTmp, []byte(strconv.Itoa(b.Version)+"\n"), 0o600); err != nil {
		return api.Bundle{}, err
	}
	if err := os.Rename(headTmp, filepath.Join(dir, "HEAD")); err != nil {
		return api.Bundle{}, err
	}
	stored := b
	heads[k] = &stored
	return b, nil
}

func (s *DiskStore) GetBundle(tenant string, k BundleKey, version int) (api.Bundle, bool) {
	if !ValidTenant(tenant) || ValidKey(k) != nil {
		return api.Bundle{}, false
	}
	s.bmu.Lock()
	defer s.bmu.Unlock()
	head, ok := s.headsFor(tenant)[k]
	if !ok {
		return api.Bundle{}, false
	}
	if version == 0 || version == head.Version {
		return *head, true
	}
	if version < 0 || version > head.Version {
		return api.Bundle{}, false
	}
	return readVersion(s.bundleDir(tenant, k), version)
}

func (s *DiskStore) ListBundles(tenant string, f BundleFilter) []api.Bundle {
	out := []api.Bundle{}
	if !ValidTenant(tenant) {
		return out
	}
	s.bmu.Lock()
	defer s.bmu.Unlock()
	for k, b := range s.headsFor(tenant) {
		if f.Scope != "" && k.Scope != f.Scope {
			continue
		}
		if f.Agent != "" && k.Agent != f.Agent {
			continue
		}
		if f.Project != "" && k.Project != f.Project {
			continue
		}
		if f.Name != "" && k.Name != f.Name {
			continue
		}
		out = append(out, *b)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Scope != b.Scope {
			return a.Scope < b.Scope
		}
		if a.Agent != b.Agent {
			return a.Agent < b.Agent
		}
		if a.Project != b.Project {
			return a.Project < b.Project
		}
		return a.Name < b.Name
	})
	return out
}

func (s *DiskStore) BundleHistory(tenant string, k BundleKey) []api.Bundle {
	out := []api.Bundle{}
	if !ValidTenant(tenant) || ValidKey(k) != nil {
		return out
	}
	s.bmu.Lock()
	defer s.bmu.Unlock()
	head, ok := s.headsFor(tenant)[k]
	if !ok {
		return out
	}
	dir := s.bundleDir(tenant, k)
	for v := head.Version; v >= 1; v-- {
		if b, ok := readVersion(dir, v); ok {
			out = append(out, b)
		}
	}
	return out
}

func (s *DiskStore) DeleteBundle(tenant string, k BundleKey) error {
	if !ValidTenant(tenant) {
		return fmt.Errorf("invalid tenant %q", tenant)
	}
	if err := ValidKey(k); err != nil {
		return err
	}
	s.bmu.Lock()
	defer s.bmu.Unlock()
	heads := s.headsFor(tenant)
	if _, ok := heads[k]; !ok {
		return os.ErrNotExist
	}
	// Only this unit's own files go: other units may nest below it on disk.
	dir := s.bundleDir(tenant, k)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		n := e.Name()
		if n == "HEAD" || n == "HEAD.tmp" || strings.HasPrefix(n, "v") && (strings.HasSuffix(n, ".json") || strings.HasSuffix(n, ".json.tmp")) {
			if err := os.Remove(filepath.Join(dir, n)); err != nil {
				return err
			}
		}
	}
	delete(heads, k)
	// Prune now-empty directories up to the tenant's bundle root.
	stop := s.bundlesDir(tenant)
	for d := dir; d != stop && strings.HasPrefix(d, stop); d = filepath.Dir(d) {
		if os.Remove(d) != nil {
			break
		}
	}
	return nil
}

// ---- SKILL.md frontmatter ----

// parseSkills extracts name/description from every SKILL.md in files.
func (s *DiskStore) parseSkills(tenant string, files []api.BundleFile) ([]api.SkillMeta, error) {
	skills := []api.SkillMeta{}
	for _, f := range files {
		if path.Base(f.Path) != "SKILL.md" {
			continue
		}
		rc, err := s.OpenBlob(tenant, f.SHA256)
		if err != nil {
			return nil, fmt.Errorf("%w: %s", ErrMissingBlob, f.SHA256)
		}
		name, desc := ParseFrontmatter(io.LimitReader(rc, 64<<10))
		rc.Close()
		skills = append(skills, api.SkillMeta{Path: f.Path, Name: name, Description: desc})
	}
	sort.Slice(skills, func(i, j int) bool { return skills[i].Path < skills[j].Path })
	return skills, nil
}

// ParseFrontmatter reads a leading "---" YAML-ish block and returns the
// top-level name and description scalars. Simple "key: value" lines and
// ">" / "|" block scalars (folded to one line) are understood; quotes around
// the value are stripped.
func ParseFrontmatter(r io.Reader) (name, desc string) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 64<<10)
	if !sc.Scan() || strings.TrimSpace(strings.TrimPrefix(sc.Text(), "\ufeff")) != "---" {
		return "", ""
	}
	var block *string // target of a ">" / "|" block scalar being collected
	var blockLines []string
	flush := func() {
		if block != nil {
			*block = strings.TrimSpace(strings.Join(blockLines, " "))
		}
		block, blockLines = nil, nil
	}
	for sc.Scan() {
		line := sc.Text()
		if strings.TrimSpace(line) == "---" {
			break
		}
		if line == "" || line[0] == ' ' || line[0] == '\t' {
			if block != nil && strings.TrimSpace(line) != "" {
				blockLines = append(blockLines, strings.TrimSpace(line))
			}
			continue
		}
		flush()
		if line[0] == '#' {
			continue
		}
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		val = strings.TrimSpace(val)
		if val == ">" || val == "|" || val == ">-" || val == "|-" {
			switch strings.TrimSpace(key) {
			case "name":
				block = &name
			case "description":
				block = &desc
			}
			continue
		}
		if len(val) >= 2 && (val[0] == '"' && val[len(val)-1] == '"' || val[0] == '\'' && val[len(val)-1] == '\'') {
			val = val[1 : len(val)-1]
		}
		switch strings.TrimSpace(key) {
		case "name":
			name = val
		case "description":
			desc = val
		}
	}
	flush()
	return name, desc
}
