package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"

	"github.com/stift-sh/stift/engine/api"
)

const (
	maxBlobCheck      = 10000
	maxBundleManifest = 2 << 20
)

// bundleKeyFrom builds the BundleKey addressed by a
// /v1/bundles/{scope}/{agent}/{name...} request; the project (scope=project
// only) comes from the query string. The name is validated by the store.
func bundleKeyFrom(r *http.Request) BundleKey {
	return BundleKey{
		Scope:   r.PathValue("scope"),
		Agent:   r.PathValue("agent"),
		Project: r.URL.Query().Get("project"),
		Name:    r.PathValue("name"),
	}
}

// requireScopeWrite enforces that org-scope writes come from an admin.
func requireScopeWrite(w http.ResponseWriter, r *http.Request, k BundleKey) bool {
	if k.Scope == "org" && !identityFrom(r).Admin {
		writeErr(w, http.StatusForbidden, "org scope requires an admin token")
		return false
	}
	return true
}

func (s *Server) handleBlobsCheck(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SHAs []string `json:"shas"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, maxBundleManifest)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request body: "+err.Error())
		return
	}
	if len(req.SHAs) > maxBlobCheck {
		writeErr(w, http.StatusBadRequest, fmt.Sprintf("at most %d shas per check", maxBlobCheck))
		return
	}
	missing, err := s.store.HasBlobs(identityFrom(r).Tenant, req.SHAs)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if missing == nil {
		missing = []string{}
	}
	writeJSON(w, http.StatusOK, map[string][]string{"missing": missing})
}

func (s *Server) handleBlobPut(w http.ResponseWriter, r *http.Request) {
	sha := r.PathValue("sha")
	if !validSHA(sha) {
		writeErr(w, http.StatusBadRequest, "invalid sha256 in path")
		return
	}
	if r.ContentLength < 0 {
		writeErr(w, http.StatusLengthRequired, "Content-Length is required")
		return
	}
	if r.ContentLength > s.cfg.MaxBlobBytes {
		writeErr(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("blob exceeds limit of %d bytes", s.cfg.MaxBlobBytes))
		return
	}
	body := http.MaxBytesReader(w, r.Body, s.cfg.MaxBlobBytes)
	if err := s.store.PutBlob(identityFrom(r).Tenant, sha, body, r.ContentLength); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeErr(w, http.StatusRequestEntityTooLarge,
				fmt.Sprintf("blob exceeds limit of %d bytes", tooBig.Limit))
			return
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"sha": sha})
}

func (s *Server) handleBlobGet(w http.ResponseWriter, r *http.Request) {
	sha := r.PathValue("sha")
	if !validSHA(sha) {
		writeErr(w, http.StatusBadRequest, "invalid sha256 in path")
		return
	}
	rc, err := s.store.OpenBlob(identityFrom(r).Tenant, sha)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeErr(w, http.StatusNotFound, "no such blob")
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusOK)
	io.Copy(w, rc)
}

func (s *Server) handleBundleList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	out := s.store.ListBundles(identityFrom(r).Tenant, BundleFilter{
		Scope:   q.Get("scope"),
		Agent:   q.Get("agent"),
		Project: q.Get("project"),
		Name:    q.Get("name"),
	})
	if out == nil {
		out = []api.Bundle{}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleBundlePut(w http.ResponseWriter, r *http.Request) {
	k := bundleKeyFrom(r)
	if !requireScopeWrite(w, r, k) {
		return
	}
	var b api.Bundle
	if err := json.NewDecoder(io.LimitReader(r.Body, maxBundleManifest)).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "bad bundle: "+err.Error())
		return
	}
	id := identityFrom(r)
	force := r.URL.Query().Get("force") == "1"
	b.Scope, b.Agent, b.Project, b.Name = k.Scope, k.Agent, k.Project, k.Name
	if b.Author == "" {
		b.Author = id.Name
	}
	stored, err := s.store.PutBundle(id.Tenant, k, b, force)
	if err != nil {
		switch {
		case errors.Is(err, ErrStale):
			msg := err.Error()
			if head, ok := s.store.GetBundle(id.Tenant, k, 0); ok {
				msg = fmt.Sprintf("stale: current head is version %d, bundle parent is %d", head.Version, b.Parent)
			}
			writeErr(w, http.StatusConflict, msg)
		case errors.Is(err, ErrMissingBlob):
			writeErr(w, http.StatusPreconditionFailed, err.Error())
		default:
			writeErr(w, http.StatusBadRequest, err.Error())
		}
		return
	}
	writeJSON(w, http.StatusCreated, stored)
}

// handleBundleGet serves one manifest version, or with ?history=1 every
// version of the unit newest first.
func (s *Server) handleBundleGet(w http.ResponseWriter, r *http.Request) {
	k := bundleKeyFrom(r)
	if !ValidUnitName(k.Name) {
		writeErr(w, http.StatusBadRequest, "invalid bundle name")
		return
	}
	if r.URL.Query().Get("history") == "1" {
		if _, ok := s.store.GetBundle(identityFrom(r).Tenant, k, 0); !ok {
			writeErr(w, http.StatusNotFound, "no such bundle")
			return
		}
		out := s.store.BundleHistory(identityFrom(r).Tenant, k)
		if out == nil {
			out = []api.Bundle{}
		}
		writeJSON(w, http.StatusOK, out)
		return
	}
	version := 0
	if v := r.URL.Query().Get("version"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			writeErr(w, http.StatusBadRequest, "version must be a non-negative integer")
			return
		}
		version = n
	}
	b, ok := s.store.GetBundle(identityFrom(r).Tenant, k, version)
	if !ok {
		writeErr(w, http.StatusNotFound, "no such bundle")
		return
	}
	writeJSON(w, http.StatusOK, b)
}

func (s *Server) handleBundleDelete(w http.ResponseWriter, r *http.Request) {
	k := bundleKeyFrom(r)
	if !requireScopeWrite(w, r, k) {
		return
	}
	if err := s.store.DeleteBundle(identityFrom(r).Tenant, k); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeErr(w, http.StatusNotFound, "no such bundle")
			return
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
