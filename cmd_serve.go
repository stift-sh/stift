package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/stift-sh/stift/engine/server"
)

func cmdServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	listen := fs.String("listen", env("STIFT_LISTEN", ":8580"), "address to listen on")
	dataDir := fs.String("data", env("STIFT_DATA", "./stift-data"), "data directory")
	maxUploadMB := fs.Int64("max-upload-mb", 200, "max session archive size in MB")
	fs.Parse(args)

	if err := os.MkdirAll(*dataDir, 0o700); err != nil {
		return err
	}
	store, err := server.OpenStore(*dataDir)
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	tokens, err := server.OpenTokens(*dataDir)
	if err != nil {
		return fmt.Errorf("open tokens: %w", err)
	}

	if envTok := os.Getenv("STIFT_ADMIN_TOKEN"); envTok != "" {
		if _, err := tokens.Register(envTok, "env-admin", true); err != nil {
			return err
		}
		log.Printf("admin token from STIFT_ADMIN_TOKEN registered")
	} else if tokens.Empty() {
		raw, _, err := tokens.Create("admin", true)
		if err != nil {
			return err
		}
		fmt.Printf(`
┌────────────────────────────────────────────────────────────────────────┐
│ First start: admin token created (shown once, store it somewhere safe) │
└────────────────────────────────────────────────────────────────────────┘

  %s

Connect a client with:

  stift login http://<this-host>:8580 --token %s

`, raw, raw)
	}

	handler := server.New(server.Options{
		Store:  store,
		Auth:   tokens,
		Tokens: tokens,
		Config: server.Config{MaxUploadBytes: *maxUploadMB << 20},
	})
	srv := &http.Server{
		Addr:              *listen,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("stift %s serving on %s (data: %s)", version, *listen, *dataDir)
	return srv.ListenAndServe()
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
