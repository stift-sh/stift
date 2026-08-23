package client

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/stift-sh/stift/engine/api"
)

// Client talks to a stift server.
type Client struct {
	base  string
	token string
	http  *http.Client
}

func New(base, token string) *Client {
	return &Client{
		base:  strings.TrimRight(base, "/"),
		token: token,
		http:  &http.Client{Timeout: 10 * time.Minute},
	}
}

func (c *Client) do(method, path string, body io.Reader, contentType string) (*http.Response, error) {
	req, err := http.NewRequest(method, c.base+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := c.http.Do(req)
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
		if res.StatusCode == http.StatusConflict {
			return nil, fmt.Errorf("%w: %s", ErrStale, e.Error)
		}
		return nil, fmt.Errorf("server: %s", e.Error)
	}
	return res, nil
}

func (c *Client) getJSON(path string, out any) error {
	res, err := c.do(http.MethodGet, path, nil, "")
	if err != nil {
		return err
	}
	defer res.Body.Close()
	return json.NewDecoder(res.Body).Decode(out)
}

func (c *Client) Whoami() (api.Whoami, error) {
	var w api.Whoami
	return w, c.getJSON("/v1/whoami", &w)
}

// Push uploads a session archive read from archivePath.
func (c *Client) Push(meta api.Session, archivePath string) (api.PushResult, error) {
	var out api.PushResult
	f, err := os.Open(archivePath)
	if err != nil {
		return out, err
	}
	defer f.Close()

	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	go func() {
		metaJSON, _ := json.Marshal(meta)
		var err error
		defer func() { pw.CloseWithError(err) }()
		var part io.Writer
		if part, err = mw.CreateFormField("meta"); err != nil {
			return
		}
		if _, err = part.Write(metaJSON); err != nil {
			return
		}
		if part, err = mw.CreateFormFile("archive", "session.tar.gz"); err != nil {
			return
		}
		if _, err = io.Copy(part, f); err != nil {
			return
		}
		err = mw.Close()
	}()

	res, err := c.do(http.MethodPost, "/v1/sessions", pr, mw.FormDataContentType())
	if err != nil {
		return out, err
	}
	defer res.Body.Close()
	return out, json.NewDecoder(res.Body).Decode(&out)
}

// ListFilter narrows List results.
type ListFilter struct {
	Agent, Project, Host, Query string
}

func (c *Client) List(f ListFilter) ([]api.Session, error) {
	q := url.Values{}
	if f.Agent != "" {
		q.Set("agent", f.Agent)
	}
	if f.Project != "" {
		q.Set("project", f.Project)
	}
	if f.Host != "" {
		q.Set("host", f.Host)
	}
	if f.Query != "" {
		q.Set("q", f.Query)
	}
	path := "/v1/sessions"
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	var out []api.Session
	return out, c.getJSON(path, &out)
}

func (c *Client) Get(id string) (api.Session, error) {
	var s api.Session
	return s, c.getJSON("/v1/sessions/"+url.PathEscape(id), &s)
}

// Download returns the archive stream for a session; caller must Close it.
func (c *Client) Download(id string) (io.ReadCloser, error) {
	res, err := c.do(http.MethodGet, "/v1/sessions/"+url.PathEscape(id)+"/archive", nil, "")
	if err != nil {
		return nil, err
	}
	return res.Body, nil
}

func (c *Client) Delete(id string) error {
	res, err := c.do(http.MethodDelete, "/v1/sessions/"+url.PathEscape(id), nil, "")
	if err != nil {
		return err
	}
	return res.Body.Close()
}

func (c *Client) TokenCreate(name string, admin bool) (api.TokenCreated, error) {
	body, _ := json.Marshal(map[string]any{"name": name, "admin": admin})
	var out api.TokenCreated
	res, err := c.do(http.MethodPost, "/v1/tokens", bytes.NewReader(body), "application/json")
	if err != nil {
		return out, err
	}
	defer res.Body.Close()
	return out, json.NewDecoder(res.Body).Decode(&out)
}

func (c *Client) TokenList() ([]api.TokenInfo, error) {
	var out []api.TokenInfo
	return out, c.getJSON("/v1/tokens", &out)
}

func (c *Client) TokenRevoke(id string) error {
	res, err := c.do(http.MethodDelete, "/v1/tokens/"+url.PathEscape(id), nil, "")
	if err != nil {
		return err
	}
	return res.Body.Close()
}

// ErrStale is wrapped into the error returned by PutBundle when the server
// rejects the push because the bundle's parent is not the current head (409).
var ErrStale = errors.New("bundle is stale")

// BundleKey identifies one bundle (config unit); Project is set only for
// scope=project and Name is the unit's path relative to the agent's config
// root ("skills/deploy", "commands/fix-tests", "CLAUDE.md").
type BundleKey struct{ Scope, Agent, Project, Name string }

// BundleFilter narrows ListBundles; zero value matches everything.
type BundleFilter struct{ Scope, Agent, Project, Name string }

// BlobsCheck returns the subset of shas the server does not have.
func (c *Client) BlobsCheck(shas []string) ([]string, error) {
	body, _ := json.Marshal(map[string][]string{"shas": shas})
	res, err := c.do(http.MethodPost, "/v1/blobs/check", bytes.NewReader(body), "application/json")
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var out struct {
		Missing []string `json:"missing"`
	}
	return out.Missing, json.NewDecoder(res.Body).Decode(&out)
}

// PutBlob uploads size bytes from r as the content-addressed blob sha.
func (c *Client) PutBlob(sha string, r io.Reader, size int64) error {
	req, err := http.NewRequest(http.MethodPut, c.base+"/v1/blobs/"+url.PathEscape(sha), r)
	if err != nil {
		return err
	}
	req.ContentLength = size
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/octet-stream")
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		var e api.Error
		json.NewDecoder(io.LimitReader(res.Body, 64*1024)).Decode(&e)
		if e.Error == "" {
			e.Error = res.Status
		}
		return fmt.Errorf("server: %s", e.Error)
	}
	return nil
}

// GetBlob returns the raw content stream of a blob; caller must Close it.
func (c *Client) GetBlob(sha string) (io.ReadCloser, error) {
	res, err := c.do(http.MethodGet, "/v1/blobs/"+url.PathEscape(sha), nil, "")
	if err != nil {
		return nil, err
	}
	return res.Body, nil
}

func bundlePath(k BundleKey, extra url.Values) string {
	p := "/v1/bundles/" + url.PathEscape(k.Scope) + "/" + url.PathEscape(k.Agent)
	for _, seg := range strings.Split(k.Name, "/") {
		p += "/" + url.PathEscape(seg)
	}
	q := url.Values{}
	if k.Project != "" {
		q.Set("project", k.Project)
	}
	for key, vs := range extra {
		q[key] = vs
	}
	if len(q) > 0 {
		p += "?" + q.Encode()
	}
	return p
}

// ListBundles returns the HEAD manifest of every bundle matching f.
func (c *Client) ListBundles(f BundleFilter) ([]api.Bundle, error) {
	q := url.Values{}
	if f.Scope != "" {
		q.Set("scope", f.Scope)
	}
	if f.Agent != "" {
		q.Set("agent", f.Agent)
	}
	if f.Project != "" {
		q.Set("project", f.Project)
	}
	if f.Name != "" {
		q.Set("name", f.Name)
	}
	path := "/v1/bundles"
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	var out []api.Bundle
	return out, c.getJSON(path, &out)
}

// PutBundle publishes a new bundle version. The returned error wraps ErrStale
// when the server's head moved past bundle.Parent; retry with force to override.
func (c *Client) PutBundle(k BundleKey, bundle api.Bundle, force bool) (api.Bundle, error) {
	var out api.Bundle
	extra := url.Values{}
	if force {
		extra.Set("force", "1")
	}
	body, _ := json.Marshal(bundle)
	res, err := c.do(http.MethodPut, bundlePath(k, extra), bytes.NewReader(body), "application/json")
	if err != nil {
		return out, err
	}
	defer res.Body.Close()
	return out, json.NewDecoder(res.Body).Decode(&out)
}

// GetBundle fetches one manifest version; version 0 means HEAD.
func (c *Client) GetBundle(k BundleKey, version int) (api.Bundle, error) {
	extra := url.Values{}
	if version > 0 {
		extra.Set("version", strconv.Itoa(version))
	}
	var out api.Bundle
	return out, c.getJSON(bundlePath(k, extra), &out)
}

// BundleHistory returns every version of a bundle, newest first.
func (c *Client) BundleHistory(k BundleKey) ([]api.Bundle, error) {
	var out []api.Bundle
	return out, c.getJSON(bundlePath(k, url.Values{"history": {"1"}}), &out)
}

func (c *Client) DeleteBundle(k BundleKey) error {
	res, err := c.do(http.MethodDelete, bundlePath(k, nil), nil, "")
	if err != nil {
		return err
	}
	return res.Body.Close()
}
