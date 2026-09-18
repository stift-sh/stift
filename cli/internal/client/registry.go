package client

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/stift-sh/stift/internal/api"
)

// Registry reads a stift server's public registry (`/v1/registry`). It
// sends no token: everything it can reach is what an admin published, and
// every file it fetches is verified against the manifest's sha256 by
// bundle.Apply.
type Registry struct {
	base string
	http *http.Client
}

// NewRegistry returns a client for the registry at base.
func NewRegistry(base string) *Registry {
	return &Registry{base: strings.TrimRight(base, "/"), http: &http.Client{Timeout: 10 * time.Minute}}
}

// URL returns the registry's base URL.
func (r *Registry) URL() string { return r.base }

func (r *Registry) get(path string) (*http.Response, error) {
	res, err := r.http.Get(r.base + path)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 400 {
		defer res.Body.Close()
		var e api.Error
		json.NewDecoder(io.LimitReader(res.Body, 64*1024)).Decode(&e)
		if e.Error == "" {
			e.Error = res.Status
		}
		if res.StatusCode == http.StatusNotFound {
			return nil, fmt.Errorf("%w: %s", ErrNotFound, e.Error)
		}
		return nil, fmt.Errorf("registry %s: %s", r.base, e.Error)
	}
	return res, nil
}

func (r *Registry) getJSON(path string, out any) error {
	res, err := r.get(path)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	// A web page where JSON was expected: the URL is not a stift registry
	// (a reverse proxy, an older server, a typo).
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		return fmt.Errorf("%s does not answer as a stift registry (%s)", r.base, oneOf(ct, "no content type"))
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func oneOf(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// Version returns the server's version and feature flags; `registry` among
// the features means the public routes are mounted.
func (r *Registry) Version() (api.Version, error) { return serverVersion(r.http, r.base) }

// HasRegistry reports whether the server advertises the registry feature.
func (r *Registry) HasRegistry() bool {
	v, err := r.Version()
	if err != nil {
		return false
	}
	for _, f := range v.Features {
		if f == "registry" {
			return true
		}
	}
	return false
}

func serverVersion(h *http.Client, base string) (api.Version, error) {
	var v api.Version
	res, err := h.Get(base + "/api/version")
	if err != nil {
		return v, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		return v, fmt.Errorf("%s: %s", base, res.Status)
	}
	return v, json.NewDecoder(res.Body).Decode(&v)
}

func skillPath(org, name string, version int) string {
	p := "/v1/registry/skills/" + url.PathEscape("@"+org) + "/" + url.PathEscape(name)
	if version > 0 {
		p += "/" + strconv.Itoa(version)
	}
	return p
}

// Get resolves `@org/name` at one version (0 = latest visible).
func (r *Registry) Get(org, name string, version int) (api.RegistrySkill, error) {
	var out api.RegistrySkill
	return out, r.getJSON(skillPath(org, name, version), &out)
}

// Search returns one page of visible published skills matching q (empty
// matches all), newest first; cursor continues a previous page.
func (r *Registry) Search(q string, limit int, cursor string) (api.RegistrySearch, error) {
	qs := url.Values{}
	if q != "" {
		qs.Set("q", q)
	}
	if limit > 0 {
		qs.Set("limit", strconv.Itoa(limit))
	}
	if cursor != "" {
		qs.Set("cursor", cursor)
	}
	p := "/v1/registry/skills"
	if len(qs) > 0 {
		p += "?" + qs.Encode()
	}
	var out api.RegistrySearch
	return out, r.getJSON(p, &out)
}

// Blob returns the content of a file of one published version; caller must
// Close it. Only shas in that version's manifest resolve.
func (r *Registry) Blob(org, name string, version int, sha string) (io.ReadCloser, error) {
	res, err := r.get(skillPath(org, name, version) + "/blobs/" + url.PathEscape(sha))
	if err != nil {
		return nil, err
	}
	return res.Body, nil
}

// Fetch returns a blob fetcher bound to one published version, the shape
// bundle.Apply takes.
func (r *Registry) Fetch(org, name string, version int) func(sha string) (io.ReadCloser, error) {
	return func(sha string) (io.ReadCloser, error) { return r.Blob(org, name, version, sha) }
}
