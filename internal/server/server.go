// Package server implements the stift HTTP API.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"

	"stift/internal/api"
)

// Config tunes the HTTP server.
type Config struct {
	MaxUploadBytes int64 // per-session archive size limit
}

type Server struct {
	store  *Store
	tokens *Tokens
	cfg    Config
}

type ctxKey int

const tokenKey ctxKey = 0

func New(store *Store, tokens *Tokens, cfg Config) http.Handler {
	if cfg.MaxUploadBytes <= 0 {
		cfg.MaxUploadBytes = 200 << 20
	}
	s := &Server{store: store, tokens: tokens, cfg: cfg}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /{$}", serveWebUI)
	mux.Handle("GET /v1/whoami", s.auth(false, s.handleWhoami))
	mux.Handle("POST /v1/sessions", s.auth(false, s.handlePush))
	mux.Handle("GET /v1/sessions", s.auth(false, s.handleList))
	mux.Handle("GET /v1/sessions/{id}", s.auth(false, s.handleGet))
	mux.Handle("GET /v1/sessions/{id}/archive", s.auth(false, s.handleDownload))
	mux.Handle("DELETE /v1/sessions/{id}", s.auth(false, s.handleDelete))
	mux.Handle("GET /v1/tokens", s.auth(true, s.handleTokenList))
	mux.Handle("POST /v1/tokens", s.auth(true, s.handleTokenCreate))
	mux.Handle("DELETE /v1/tokens/{id}", s.auth(true, s.handleTokenRevoke))
	return logRequests(mux)
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.RemoteAddr, r.Method, r.URL.Path)
	})
}

func (s *Server) auth(needAdmin bool, next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if raw == "" || raw == r.Header.Get("Authorization") {
			writeErr(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		tok, ok := s.tokens.Check(raw)
		if !ok {
			writeErr(w, http.StatusUnauthorized, "invalid token")
			return
		}
		if needAdmin && !tok.Admin {
			writeErr(w, http.StatusForbidden, "admin token required")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), tokenKey, tok)))
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, api.Error{Error: msg})
}

func (s *Server) handleWhoami(w http.ResponseWriter, r *http.Request) {
	tok := r.Context().Value(tokenKey).(api.TokenInfo)
	writeJSON(w, http.StatusOK, api.Whoami{Name: tok.Name, Admin: tok.Admin})
}

// handlePush accepts multipart/form-data with a "meta" JSON field and an
// "archive" tar.gz file field.
func (s *Server) handlePush(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes)
	mr, err := r.MultipartReader()
	if err != nil {
		writeErr(w, http.StatusBadRequest, "expected multipart/form-data: "+err.Error())
		return
	}
	var meta api.Session
	haveMeta := false
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		switch part.FormName() {
		case "meta":
			if err := json.NewDecoder(io.LimitReader(part, 1<<20)).Decode(&meta); err != nil {
				writeErr(w, http.StatusBadRequest, "bad meta: "+err.Error())
				return
			}
			haveMeta = true
		case "archive":
			if !haveMeta {
				writeErr(w, http.StatusBadRequest, "meta field must precede archive field")
				return
			}
			if meta.Key == "" || meta.Agent == "" || meta.SessionID == "" {
				writeErr(w, http.StatusBadRequest, "meta requires key, agent and session_id")
				return
			}
			if meta.Base != "home" && meta.Base != "project" {
				writeErr(w, http.StatusBadRequest, `meta.base must be "home" or "project"`)
				return
			}
			sess, status, err := s.store.Put(meta, part)
			if err != nil {
				var tooBig *http.MaxBytesError
				if errors.As(err, &tooBig) {
					writeErr(w, http.StatusRequestEntityTooLarge,
						fmt.Sprintf("archive exceeds limit of %d bytes", tooBig.Limit))
					return
				}
				writeErr(w, http.StatusInternalServerError, err.Error())
				return
			}
			code := http.StatusOK
			if status == "created" {
				code = http.StatusCreated
			}
			writeJSON(w, code, api.PushResult{Session: sess, Status: status})
			return
		}
	}
	writeErr(w, http.StatusBadRequest, "missing archive field")
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	sessions := s.store.List(ListFilter{
		Agent:   q.Get("agent"),
		Project: q.Get("project"),
		Host:    q.Get("host"),
		Query:   q.Get("q"),
	})
	writeJSON(w, http.StatusOK, sessions)
}

func (s *Server) resolve(w http.ResponseWriter, r *http.Request) (string, bool) {
	id, err := s.store.ResolveID(r.PathValue("id"))
	if errors.Is(err, os.ErrNotExist) {
		writeErr(w, http.StatusNotFound, "no such session")
		return "", false
	}
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return "", false
	}
	return id, true
}

func (s *Server) handleGet(w http.ResponseWriter, r *http.Request) {
	id, ok := s.resolve(w, r)
	if !ok {
		return
	}
	sess, _ := s.store.Get(id)
	writeJSON(w, http.StatusOK, sess)
}

func (s *Server) handleDownload(w http.ResponseWriter, r *http.Request) {
	id, ok := s.resolve(w, r)
	if !ok {
		return
	}
	f, sess, err := s.store.OpenArchive(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="%s-%s.tar.gz"`, sess.Agent, sess.ID))
	http.ServeContent(w, r, "", sess.UpdatedAt, f)
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	id, ok := s.resolve(w, r)
	if !ok {
		return
	}
	if err := s.store.Delete(id); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleTokenList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.tokens.List())
}

func (s *Server) handleTokenCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name  string `json:"name"`
		Admin bool   `json:"admin"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request body: "+err.Error())
		return
	}
	if req.Name == "" {
		writeErr(w, http.StatusBadRequest, "name is required")
		return
	}
	raw, info, err := s.tokens.Create(req.Name, req.Admin)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, api.TokenCreated{TokenInfo: info, Token: raw})
}

func (s *Server) handleTokenRevoke(w http.ResponseWriter, r *http.Request) {
	tok := r.Context().Value(tokenKey).(api.TokenInfo)
	id := r.PathValue("id")
	if id == tok.ID {
		writeErr(w, http.StatusBadRequest, "refusing to revoke the token used for this request")
		return
	}
	if err := s.tokens.Revoke(id); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeErr(w, http.StatusNotFound, "no such token")
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
