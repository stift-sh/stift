// Package archive packs and unpacks session file sets as tar.gz streams.
package archive

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Pack writes a tar.gz to w containing the given files. Each entry's name is
// the file's path relative to baseDir, with forward slashes. Returns the
// number of files written.
func Pack(w io.Writer, baseDir string, files []string) (int, error) {
	gz := gzip.NewWriter(w)
	tw := tar.NewWriter(gz)
	n := 0
	for _, f := range files {
		abs := f
		if !filepath.IsAbs(abs) {
			abs = filepath.Join(baseDir, f)
		}
		rel, err := filepath.Rel(baseDir, abs)
		if err != nil {
			return n, fmt.Errorf("relativize %s: %w", f, err)
		}
		rel = filepath.ToSlash(rel)
		if !isLocalName(rel) {
			return n, fmt.Errorf("file %s escapes base directory", f)
		}
		info, err := os.Stat(abs)
		if err != nil {
			return n, err
		}
		if !info.Mode().IsRegular() {
			continue
		}
		hdr, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return n, err
		}
		hdr.Name = rel
		if err := tw.WriteHeader(hdr); err != nil {
			return n, err
		}
		src, err := os.Open(abs)
		if err != nil {
			return n, err
		}
		_, err = io.Copy(tw, src)
		src.Close()
		if err != nil {
			return n, err
		}
		n++
	}
	if err := tw.Close(); err != nil {
		return n, err
	}
	return n, gz.Close()
}

// UnpackResult reports what Unpack did.
type UnpackResult struct {
	Extracted int
	Skipped   []string // existing files left alone (overwrite=false)
}

// Unpack extracts a tar.gz stream into baseDir. Entry names must be local
// (no absolute paths, no ".." traversal) or the whole operation fails.
// When overwrite is false, existing files are skipped and reported.
func Unpack(r io.Reader, baseDir string, overwrite bool) (UnpackResult, error) {
	var res UnpackResult
	gz, err := gzip.NewReader(r)
	if err != nil {
		return res, fmt.Errorf("invalid gzip stream: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return res, nil
		}
		if err != nil {
			return res, err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		name := filepath.FromSlash(hdr.Name)
		if !isLocalName(hdr.Name) {
			return res, fmt.Errorf("archive entry %q has unsafe path", hdr.Name)
		}
		dst := filepath.Join(baseDir, name)
		if !overwrite {
			if _, err := os.Lstat(dst); err == nil {
				res.Skipped = append(res.Skipped, hdr.Name)
				continue
			}
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return res, err
		}
		out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, fs(hdr.Mode))
		if err != nil {
			return res, err
		}
		_, err = io.Copy(out, tr)
		if cerr := out.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return res, err
		}
		if !hdr.ModTime.IsZero() {
			os.Chtimes(dst, hdr.ModTime, hdr.ModTime)
		}
		res.Extracted++
	}
}

func fs(mode int64) os.FileMode {
	m := os.FileMode(mode) & 0o777
	if m == 0 {
		m = 0o644
	}
	return m
}

func isLocalName(name string) bool {
	if name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, "\\") {
		return false
	}
	return filepath.IsLocal(filepath.FromSlash(name))
}
