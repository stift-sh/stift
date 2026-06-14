package client

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
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
