package registry

import "testing"

func TestParse(t *testing.T) {
	good := map[string]Ref{
		"@acme/deploy":        {Org: "acme", Name: "deploy"},
		"@acme/deploy@3":      {Org: "acme", Name: "deploy", Version: 3},
		"@acme/deploy@latest": {Org: "acme", Name: "deploy"},
		"@a-1/b2":             {Org: "a-1", Name: "b2"},
	}
	for in, want := range good {
		got, err := Parse(in)
		if err != nil || got != want {
			t.Errorf("Parse(%q) = %+v, %v; want %+v", in, got, err, want)
		}
	}
	for _, in := range []string{"", "acme/deploy", "@acme", "@acme/", "@/deploy", "@Acme/deploy", "@acme/deploy@0", "@acme/deploy@x", "@acme/d", "@acme/skills/deploy", "@acme/deploy@3@4"} {
		if _, err := Parse(in); err == nil {
			t.Errorf("Parse(%q) accepted", in)
		}
	}
	if s := (Ref{Org: "acme", Name: "deploy", Version: 2}).String(); s != "@acme/deploy@2" {
		t.Errorf("String() = %q", s)
	}
	if s := (Ref{Org: "acme", Name: "deploy", Version: 2}).Base(); s != "@acme/deploy" {
		t.Errorf("Base() = %q", s)
	}
}
