// Package bundle builds, diffs and applies agent-configuration bundles
// (manifest + content-addressed blobs) on the client side.
package bundle

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/stift-sh/stift/internal/agents"
	"github.com/stift-sh/stift/internal/api"
)

// Build returns the manifest of one unit: every included file below the
// unit's directory (or, for a file unit, that single file), with paths
// relative to the unit, plus a map from sha256 to the local path of one file
// with that content. root supplies the exclude patterns. Warnings (skipped
// symlinks, oversized files) are returned separately.
func Build(root agents.ConfigRoot, u agents.Unit) (api.Bundle, map[string]string, []string, error) {
	b := api.Bundle{Scope: api.BundleScope(root.Scope), Name: u.Name, Files: []api.BundleFile{}}
	blobs := map[string]string{}
	var warnings []string

	addFile := func(rel, p string, fi os.FileInfo) error {
		if fi.Size() > agents.MaxConfigFileSize {
			warnings = append(warnings, fmt.Sprintf("skipping %s: larger than %d MB", p, agents.MaxConfigFileSize>>20))
			return nil
		}
		sum, err := fileSHA(p)
		if err != nil {
			return err
		}
		mode := 0o644
		if fi.Mode()&0o111 != 0 {
			mode = 0o755
		}
		b.Files = append(b.Files, api.BundleFile{Path: rel, Sha256: sum, Size: int(fi.Size()), Mode: mode})
		if _, ok := blobs[sum]; !ok {
			blobs[sum] = p
		}
		return nil
	}

	info, err := os.Lstat(u.Path)
	if err != nil {
		return b, blobs, warnings, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return b, blobs, append(warnings, fmt.Sprintf("skipping symlink %s", u.Path)), nil
	}
	if u.IsFile || !info.IsDir() {
		if !info.Mode().IsRegular() {
			return b, blobs, warnings, fmt.Errorf("%s: not a regular file", u.Path)
		}
		return b, blobs, warnings, addFile(filepath.Base(u.Path), u.Path, info)
	}
	// Exclude patterns are root-relative; keep that frame while walking.
	unitRel := u.Rel(root)
	err = filepath.WalkDir(u.Path, func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == u.Path {
			return nil
		}
		rel, err := filepath.Rel(u.Path, p)
		if err != nil || !filepath.IsLocal(rel) {
			return nil
		}
		rel = filepath.ToSlash(rel)
		rootRel := path.Join(unitRel, rel)
		name := d.Name()
		if d.IsDir() {
			if agents.Excluded(root.Exclude, rootRel, name) {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			if target, err := os.Readlink(p); err != nil || !strings.Contains(filepath.ToSlash(target), "/.stift/org/") {
				warnings = append(warnings, fmt.Sprintf("skipping symlink %s", p))
			}
			return nil
		}
		if !d.Type().IsRegular() || agents.Excluded(root.Exclude, rootRel, name) {
			return nil
		}
		fi, err := d.Info()
		if err != nil {
			return nil
		}
		return addFile(rel, p, fi)
	})
	if err != nil {
		return b, nil, warnings, err
	}
	sort.Slice(b.Files, func(i, j int) bool { return b.Files[i].Path < b.Files[j].Path })
	return b, blobs, warnings, nil
}

// BuildAll builds every unit of root, returning the bundles in unit order
// and the union of their blobs.
func BuildAll(root agents.ConfigRoot) ([]api.Bundle, map[string]string, []string, error) {
	units, warnings := root.Units()
	blobs := map[string]string{}
	var out []api.Bundle
	for _, u := range units {
		b, bl, w, err := Build(root, u)
		warnings = append(warnings, w...)
		if err != nil {
			return out, blobs, warnings, fmt.Errorf("%s: %w", u.Name, err)
		}
		for k, v := range bl {
			blobs[k] = v
		}
		out = append(out, b)
	}
	return out, blobs, warnings, nil
}

// Paths returns the file paths of a bundle, for agents.UnitDir.
func Paths(b api.Bundle) []string {
	out := make([]string, len(b.Files))
	for i, f := range b.Files {
		out[i] = f.Path
	}
	return out
}

func fileSHA(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Manifest returns path -> sha256 for a bundle.
func Manifest(b api.Bundle) map[string]string {
	m := make(map[string]string, len(b.Files))
	for _, f := range b.Files {
		m[f.Path] = f.Sha256
	}
	return m
}

// Changes is the result of Diff.
type Changes struct {
	Added, Modified, Removed []string
}

// Empty reports whether the two bundles have identical content.
func (c Changes) Empty() bool { return len(c.Added)+len(c.Modified)+len(c.Removed) == 0 }

// Diff compares a local manifest with a remote one from the local point of
// view: Added = in local only, Removed = in remote only, Modified = both
// with different content.
func Diff(local, remote api.Bundle) Changes {
	l, r := Manifest(local), Manifest(remote)
	var c Changes
	for p, sha := range l {
		switch rs, ok := r[p]; {
		case !ok:
			c.Added = append(c.Added, p)
		case rs != sha:
			c.Modified = append(c.Modified, p)
		}
	}
	for p := range r {
		if _, ok := l[p]; !ok {
			c.Removed = append(c.Removed, p)
		}
	}
	sort.Strings(c.Added)
	sort.Strings(c.Modified)
	sort.Strings(c.Removed)
	return c
}

// ApplyResult reports what Apply did (or would do, with dryRun).
type ApplyResult struct {
	Written   []string // created or updated
	Deleted   []string // removed because the remote removed them
	Conflicts []string // locally modified, left alone (pass force to overwrite)
	Unchanged int
}

// Apply writes the files of remote under baseDir. base is the manifest
// (path -> sha256) recorded at the last sync; a local file whose content
// differs from both remote and base is considered locally modified and is
// skipped unless force. Files present in base but absent from remote are
// deleted when unmodified. Writes are atomic (temp file + rename), the exec
// bit is honoured and paths that escape baseDir are refused.
func Apply(remote api.Bundle, fetch func(sha string) (io.ReadCloser, error), baseDir string, base map[string]string, force, dryRun bool) (ApplyResult, error) {
	var res ApplyResult
	baseDir = filepath.Clean(baseDir)
	remoteSet := map[string]bool{}
	for _, f := range remote.Files {
		if !validPath(f.Path) {
			return res, fmt.Errorf("refusing unsafe path %q in bundle", f.Path)
		}
		remoteSet[f.Path] = true
		dst := filepath.Join(baseDir, filepath.FromSlash(f.Path))
		cur, exists, err := localSHA(dst)
		if err != nil {
			return res, err
		}
		if exists && cur == f.Sha256 {
			res.Unchanged++
			if !dryRun {
				fixMode(dst, uint32(f.Mode))
			}
			continue
		}
		if exists && !force && cur != base[f.Path] {
			res.Conflicts = append(res.Conflicts, f.Path)
			continue
		}
		res.Written = append(res.Written, f.Path)
		if dryRun {
			continue
		}
		if err := writeBlob(dst, f, fetch); err != nil {
			return res, fmt.Errorf("%s: %w", f.Path, err)
		}
	}
	// Files removed remotely since the last sync.
	var removed []string
	for p := range base {
		if !remoteSet[p] {
			removed = append(removed, p)
		}
	}
	sort.Strings(removed)
	for _, p := range removed {
		if !validPath(p) {
			continue
		}
		dst := filepath.Join(baseDir, filepath.FromSlash(p))
		cur, exists, err := localSHA(dst)
		if err != nil || !exists {
			continue
		}
		if !force && cur != base[p] {
			res.Conflicts = append(res.Conflicts, p)
			continue
		}
		res.Deleted = append(res.Deleted, p)
		if !dryRun {
			if err := os.Remove(dst); err != nil {
				return res, err
			}
			removeEmptyParents(dst, baseDir)
		}
	}
	return res, nil
}

func validPath(p string) bool {
	if p == "" || strings.HasPrefix(p, "/") || strings.Contains(p, "\\") || path.Clean(p) != p {
		return false
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	if len(p) >= 2 && p[1] == ':' {
		return false
	}
	return filepath.IsLocal(filepath.FromSlash(p))
}

// localSHA returns the sha256 of a regular file, or exists=false when the
// path is absent. Symlinks and directories count as existing with an empty
// hash so they are never silently replaced without force.
func localSHA(p string) (sha string, exists bool, err error) {
	info, err := os.Lstat(p)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", false, nil
		}
		return "", false, err
	}
	if !info.Mode().IsRegular() {
		return "", true, nil
	}
	sha, err = fileSHA(p)
	return sha, true, err
}

func writeBlob(dst string, f api.BundleFile, fetch func(string) (io.ReadCloser, error)) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	rc, err := fetch(f.Sha256)
	if err != nil {
		return err
	}
	defer rc.Close()
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".stift-*")
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(tmp, h), rc)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil && hex.EncodeToString(h.Sum(nil)) != f.Sha256 {
		err = fmt.Errorf("blob %s: content hash mismatch", f.Sha256[:12])
	}
	if err == nil {
		err = os.Chmod(tmp.Name(), fileMode(uint32(f.Mode)))
	}
	if err == nil {
		if info, lerr := os.Lstat(dst); lerr == nil && info.IsDir() {
			err = fmt.Errorf("is a directory")
		}
	}
	if err == nil {
		err = os.Rename(tmp.Name(), dst)
	}
	if err != nil {
		os.Remove(tmp.Name())
	}
	return err
}

func fileMode(mode uint32) os.FileMode {
	if mode&0o111 != 0 {
		return 0o755
	}
	return 0o644
}

func fixMode(dst string, mode uint32) {
	if info, err := os.Stat(dst); err == nil && (info.Mode()&0o111 != 0) != (mode&0o111 != 0) {
		os.Chmod(dst, fileMode(mode))
	}
}

func removeEmptyParents(p, stop string) {
	for dir := filepath.Dir(p); dir != stop && strings.HasPrefix(dir, stop); dir = filepath.Dir(dir) {
		if os.Remove(dir) != nil {
			return
		}
	}
}
