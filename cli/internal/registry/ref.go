// Package registry holds the client-side pieces of the public skill
// registry: the `@<org>/<name>[@<version>]` reference syntax and the
// resolution of which registry to ask.
package registry

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// DefaultURL is the registry asked when nothing else names one.
const DefaultURL = "https://app.stift.sh"

// slug is the charset of both the org slug and the public name (the
// server's validSlug).
var slug = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,38}$`)

// Ref is a parsed `@<org>/<name>[@<version>]`. Version 0 means latest.
type Ref struct {
	Org     string
	Name    string
	Version int
}

// IsRef reports whether s looks like a registry reference (leading `@`),
// which routes `stift skills install` to the registry instead of the org.
func IsRef(s string) bool { return strings.HasPrefix(s, "@") }

// Parse parses `@org/name`, `@org/name@3` or `@org/name@latest`.
func Parse(s string) (Ref, error) {
	var r Ref
	bad := func() (Ref, error) {
		return r, fmt.Errorf("invalid reference %q: expected @<org>/<name>[@<version>]", s)
	}
	if !IsRef(s) {
		return bad()
	}
	rest := s[1:]
	org, tail, ok := strings.Cut(rest, "/")
	if !ok {
		return bad()
	}
	name, ver, hasVer := strings.Cut(tail, "@")
	if !slug.MatchString(org) || !slug.MatchString(name) {
		return bad()
	}
	r.Org, r.Name = org, name
	if hasVer && ver != "latest" {
		n, err := strconv.Atoi(ver)
		if err != nil || n < 1 {
			return r, fmt.Errorf("invalid reference %q: version must be a positive number or latest", s)
		}
		r.Version = n
	}
	return r, nil
}

// Base is the reference without a version: `@org/name`.
func (r Ref) Base() string { return "@" + r.Org + "/" + r.Name }

// String is the full reference, with `@<version>` when one is set.
func (r Ref) String() string {
	if r.Version > 0 {
		return r.Base() + "@" + strconv.Itoa(r.Version)
	}
	return r.Base()
}
