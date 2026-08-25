package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/stift-sh/stift/internal/client"
	"github.com/stift-sh/stift/internal/daemon"
)

// cmdDaemon runs the background sync loop in the foreground. Normally started
// by the OS service installed via `stift start` (or `stift login`).
func cmdDaemon(args []string) error {
	fs := flag.NewFlagSet("daemon", flag.ExitOnError)
	interval := fs.Duration("interval", 0, "sync interval (default 30s or $STIFT_SYNC_INTERVAL)")
	fs.Parse(args)

	c, err := client.Require()
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	host := resolveHost()

	iv := *interval
	if iv <= 0 {
		iv = daemon.DefaultInterval
		if v := os.Getenv("STIFT_SYNC_INTERVAL"); v != "" {
			if d, err := time.ParseDuration(v); err == nil {
				iv = d
			}
		}
	}

	logger := log.New(os.Stderr, "", log.LstdFlags)
	d, err := daemon.New(c, home, host, logger)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	d.Run(ctx, iv)
	return nil
}
