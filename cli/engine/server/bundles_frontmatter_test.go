package server

import (
	"strings"
	"testing"
)

func TestParseFrontmatterBlockScalar(t *testing.T) {
	src := "---\nname: pr\ndescription: >\n  Create a pull request.\n  Trigger when asked.\n\n# comment\nother: x\n---\n# body\n"
	name, desc := ParseFrontmatter(strings.NewReader(src))
	if name != "pr" {
		t.Fatalf("name = %q", name)
	}
	if want := "Create a pull request. Trigger when asked."; desc != want {
		t.Fatalf("desc = %q, want %q", desc, want)
	}
	name, desc = ParseFrontmatter(strings.NewReader("---\nname: \"x\"\ndescription: 'plain'\n---\n"))
	if name != "x" || desc != "plain" {
		t.Fatalf("plain: %q %q", name, desc)
	}
}
