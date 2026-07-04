// Package daemon runs stift's background sync: it pushes every locally-detected
// agent session and reconciles (pulls) sessions for projects present on this
// machine, so session history follows the user across machines automatically.
package daemon

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/stift-sh/stift/engine/api"
	"github.com/stift-sh/stift/engine/archive"
	"github.com/stift-sh/stift/internal/agents"
	"github.com/stift-sh/stift/internal/client"
	"github.com/stift-sh/stift/internal/gitrepo"
)

// DefaultInterval is how often the daemon runs a sync pass.
const DefaultInterval = 30 * time.Second

// Daemon holds the state for one background sync worker.
type Daemon struct {
	client *client.Client
	home   string
	host   string
	state  *State
	log    *log.Logger
}

// New builds a Daemon and loads its persisted sync state.
func New(c *client.Client, home, host string, logger *log.Logger) (*Daemon, error) {
	st, err := LoadState()
	if err != nil {
		return nil, err
	}
	return &Daemon{client: c, home: home, host: host, state: st, log: logger}, nil
}

// Run performs an immediate sync, then repeats every interval until ctx is done.
func (d *Daemon) Run(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = DefaultInterval
	}
	d.log.Printf("stift daemon started (interval %s, host %s)", interval, d.host)
	d.SyncOnce()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			d.log.Printf("stift daemon stopping")
			return
		case <-t.C:
			d.SyncOnce()
		}
	}
}

// SyncOnce runs one push pass followed by one reconcile pass and persists state.
func (d *Daemon) SyncOnce() {
	targets := d.pushPass()
	links, err := client.LoadLinks()
	if err != nil {
		d.log.Printf("links: %v", err)
	}
	for _, l := range links {
		if l.Dir != "" && l.ProjectID != "" {
			targets[l.Dir] = l.ProjectID
		}
	}
	d.reconcilePass(targets)
	if err := d.state.Save(); err != nil {
		d.log.Printf("state save: %v", err)
	}
}

// pushPass uploads every changed local session and returns the set of local
// project directories seen (dir -> project id), used as reconcile targets.
func (d *Daemon) pushPass() map[string]string {
	targets := map[string]string{}
	sessions, warnings := agents.Detect(nil, d.home, "")
	for _, w := range warnings {
		d.log.Printf("detect: %s", w)
	}
	for _, s := range sessions {
		if s.Project != "" {
			if _, ok := targets[s.Project]; !ok {
				targets[s.Project] = gitrepo.ProjectID(s.Project)
			}
		}
		key := s.Key(d.host)
		fp := fingerprint(s)
		if d.state.Pushed[key] == fp {
			continue
		}
		res, err := PushSession(d.client, s, d.host)
		if err != nil {
			d.log.Printf("push %s %s: %v", s.Agent, short(s.SessionID), err)
			continue
		}
		d.state.Pushed[key] = fp
		if res.Status != "unchanged" {
			d.log.Printf("%s %s %s [%s]", res.Status, s.Agent, short(s.SessionID), short(res.Session.ID))
		}
	}
	return targets
}

// reconcilePass pulls sessions for each target project that came from another
// machine and are not yet restored here. It lists the server once.
func (d *Daemon) reconcilePass(targets map[string]string) {
	if len(targets) == 0 {
		return
	}
	sessions, err := d.client.List(client.ListFilter{})
	if err != nil {
		d.log.Printf("reconcile: list failed: %v", err)
		return
	}
	for dir, projectID := range targets {
		d.reconcile(dir, projectID, sessions)
	}
}

// reconcile restores the sessions in the given list that belong to projectID,
// originated on another host, and have not been restored before. Returns the
// number of sessions restored.
func (d *Daemon) reconcile(dir, projectID string, sessions []api.Session) int {
	restored := 0
	for _, sess := range sessions {
		if sess.ProjectID != projectID || sess.Host == d.host || d.state.Restored[sess.ID] {
			continue
		}
		extracted, err := d.restore(sess, dir)
		if err != nil {
			d.log.Printf("reconcile %s: %s: %v", projectID, short(sess.ID), err)
			continue
		}
		d.state.Restored[sess.ID] = true
		if extracted > 0 {
			restored++
			d.log.Printf("restored %s %s (%s) into %s", sess.Agent, short(sess.SessionID), oneOfStr(sess.Title, projectID), dir)
		}
	}
	return restored
}

// restore downloads and extracts one session, never overwriting existing files,
// and returns how many files were newly written. Home-based sessions are
// relocated into dir when the agent's path scheme is project-specific (see
// remapHome).
func (d *Daemon) restore(sess api.Session, dir string) (int, error) {
	body, err := d.client.Download(sess.ID)
	if err != nil {
		return 0, err
	}
	defer body.Close()

	var baseDir string
	var rename func(string) string
	switch sess.Base {
	case "project":
		baseDir = dir
	case "home":
		baseDir = d.home
		rename = remapHome(sess, dir)
		if rename == nil && sess.Agent != "claude" {
			d.log.Printf("restoring %s session %s verbatim (no cross-machine path remap)", sess.Agent, short(sess.ID))
		}
	default:
		return 0, fmt.Errorf("unknown archive base %q", sess.Base)
	}

	res, err := archive.UnpackRemap(body, baseDir, false, rename)
	if err != nil {
		return 0, err
	}
	if len(res.Skipped) > 0 {
		d.log.Printf("restore %s: %d files already present, left unchanged", short(sess.ID), len(res.Skipped))
	}
	return res.Extracted, nil
}

// remapHome rewrites a home-based session's archive paths so it lands under the
// target project directory on this machine. v1 handles Claude Code's
// project-scoped layout (~/.claude/projects/<munged-cwd>/); other agents return
// nil and restore verbatim.
func remapHome(sess api.Session, targetDir string) func(string) string {
	if sess.Agent != "claude" || sess.Project == "" || targetDir == "" {
		return nil
	}
	srcMunged := agents.MungeClaudePath(sess.Project)
	dstMunged := agents.MungeClaudePath(targetDir)
	if srcMunged == dstMunged {
		return nil
	}
	srcPrefix := ".claude/projects/" + srcMunged + "/"
	dstPrefix := ".claude/projects/" + dstMunged + "/"
	return func(name string) string {
		if strings.HasPrefix(name, srcPrefix) {
			return dstPrefix + name[len(srcPrefix):]
		}
		return name // todos and other uuid-keyed files are machine-independent
	}
}

// ReconcileOnce pulls a single project's sessions on demand (used by
// `stift link` and `stift pull <name>`) and persists restore state. Returns the
// number of sessions restored.
func ReconcileOnce(c *client.Client, home, host, dir, projectID string, logger *log.Logger) (int, error) {
	d, err := New(c, home, host, logger)
	if err != nil {
		return 0, err
	}
	sessions, err := c.List(client.ListFilter{})
	if err != nil {
		return 0, err
	}
	n := d.reconcile(dir, projectID, sessions)
	return n, d.state.Save()
}

func short(s string) string {
	if len(s) > 8 {
		return s[:8]
	}
	return s
}

func oneOfStr(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
