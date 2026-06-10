package archive

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"
)

func TestPackUnpackRoundTrip(t *testing.T) {
	src := t.TempDir()
	files := map[string]string{
		".claude/projects/-tmp-x/abc.jsonl": `{"type":"user"}`,
		".claude/todos/abc.json":            `[]`,
	}
	var paths []string
	for rel, content := range files {
		p := filepath.Join(src, rel)
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, p)
	}

	var buf bytes.Buffer
	n, err := Pack(&buf, src, paths)
	if err != nil {
		t.Fatalf("Pack: %v", err)
	}
	if n != len(files) {
		t.Fatalf("packed %d files, want %d", n, len(files))
	}

	dst := t.TempDir()
	res, err := Unpack(bytes.NewReader(buf.Bytes()), dst, false)
	if err != nil {
		t.Fatalf("Unpack: %v", err)
	}
	if res.Extracted != len(files) {
		t.Fatalf("extracted %d files, want %d", res.Extracted, len(files))
	}
	for rel, content := range files {
		got, err := os.ReadFile(filepath.Join(dst, rel))
		if err != nil {
			t.Fatalf("missing %s: %v", rel, err)
		}
		if string(got) != content {
			t.Errorf("%s content = %q, want %q", rel, got, content)
		}
	}
}

func TestUnpackSkipsExistingWithoutForce(t *testing.T) {
	src := t.TempDir()
	p := filepath.Join(src, "file.txt")
	os.WriteFile(p, []byte("remote"), 0o644)
	var buf bytes.Buffer
	if _, err := Pack(&buf, src, []string{p}); err != nil {
		t.Fatal(err)
	}

	dst := t.TempDir()
	existing := filepath.Join(dst, "file.txt")
	os.WriteFile(existing, []byte("local"), 0o644)

	res, err := Unpack(bytes.NewReader(buf.Bytes()), dst, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Extracted != 0 || len(res.Skipped) != 1 {
		t.Fatalf("got extracted=%d skipped=%v, want 0 extracted and 1 skipped", res.Extracted, res.Skipped)
	}
	if got, _ := os.ReadFile(existing); string(got) != "local" {
		t.Errorf("existing file was overwritten without --force")
	}

	res, err = Unpack(bytes.NewReader(buf.Bytes()), dst, true)
	if err != nil || res.Extracted != 1 {
		t.Fatalf("overwrite unpack: res=%+v err=%v", res, err)
	}
	if got, _ := os.ReadFile(existing); string(got) != "remote" {
		t.Errorf("file not overwritten with force")
	}
}

func TestUnpackRejectsTraversal(t *testing.T) {
	for _, evil := range []string{"../evil.txt", "/abs/evil.txt", "a/../../evil.txt"} {
		var buf bytes.Buffer
		gz := gzip.NewWriter(&buf)
		tw := tar.NewWriter(gz)
		tw.WriteHeader(&tar.Header{Name: evil, Mode: 0o644, Size: 4, Typeflag: tar.TypeReg})
		tw.Write([]byte("pwnd"))
		tw.Close()
		gz.Close()

		dst := t.TempDir()
		if _, err := Unpack(bytes.NewReader(buf.Bytes()), dst, true); err == nil {
			t.Errorf("Unpack accepted unsafe entry %q", evil)
		}
		if _, err := os.Stat(filepath.Join(dst, "..", "evil.txt")); err == nil {
			t.Fatalf("traversal file was written for %q", evil)
		}
	}
}

func TestPackRejectsFilesOutsideBase(t *testing.T) {
	base := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.txt")
	os.WriteFile(outside, []byte("x"), 0o644)
	var buf bytes.Buffer
	if _, err := Pack(&buf, base, []string{outside}); err == nil {
		t.Fatal("Pack accepted a file outside the base directory")
	}
}
