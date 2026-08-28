package daemon

import (
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/stift-sh/stift/internal/api"
	"github.com/stift-sh/stift/internal/bundle"
	"github.com/stift-sh/stift/internal/client"
	"github.com/stift-sh/stift/internal/skillsync"
)

// DefaultSkillsDebounce is how long a unit must be unchanged before the
// daemon pushes it, so half-edited skills are not published mid-edit.
const DefaultSkillsDebounce = 2 * time.Minute

// skillsEnabled reports whether the skills pass runs (STIFT_SYNC_SKILLS=0 opts out).
func skillsEnabled() bool { return os.Getenv("STIFT_SYNC_SKILLS") != "0" }

// skillsDebounce returns the configured debounce window.
func skillsDebounce() time.Duration {
	if v := os.Getenv("STIFT_SKILLS_DEBOUNCE"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d >= 0 {
			return d
		}
	}
	return DefaultSkillsDebounce
}

// debouncer remembers, per unit, the content hash last observed and when it
// was first seen, and reports a unit as settled once its hash has been stable
// for at least the window.
type debouncer struct {
	window time.Duration
	seen   map[string]pending
}

type pending struct {
	hash  string
	first time.Time
}

func newDebouncer(window time.Duration) *debouncer {
	return &debouncer{window: window, seen: map[string]pending{}}
}

// Observe records the current hash of key at now and returns true when the
// same hash has been observed continuously for the window.
func (d *debouncer) Observe(key, hash string, now time.Time) bool {
	p, ok := d.seen[key]
	if !ok || p.hash != hash {
		d.seen[key] = pending{hash: hash, first: now}
		return d.window == 0
	}
	return now.Sub(p.first) >= d.window
}

// Forget drops a unit (after it was pushed or found unchanged).
func (d *debouncer) Forget(key string) { delete(d.seen, key) }

// manifestHash is a stable digest of a path -> sha manifest.
func manifestHash(m map[string]string) string {
	parts := make([]string, 0, len(m))
	for p, sha := range m {
		parts = append(parts, p+"="+sha)
	}
	sort.Strings(parts)
	return strings.Join(parts, "\n")
}

// pullAction decides what to do with a server HEAD for one unit.
type pullAction int

const (
	pullSkip     pullAction = iota // nothing newer on the server
	pullApply                      // apply the remote version
	pullConflict                   // newer on the server but modified locally
)

// decidePull is the pull rule: org units always apply; otherwise a newer
// server version applies only if the local unit is as the last sync left it
// (or does not exist locally at all).
func decidePull(scope string, entry bundle.Entry, remoteVersion int, localExists, localModified bool) pullAction {
	if remoteVersion <= entry.Version {
		return pullSkip
	}
	if scope == "org" {
		return pullApply
	}
	if localExists && (entry.Version == 0 || localModified) {
		return pullConflict
	}
	return pullApply
}

// skillsSync is the daemon's per-process skills state.
type skillsSync struct {
	deb    *debouncer
	logged map[string]bool // "label@version" of stale/conflict notices already logged
}

// once reports whether a notice for unit label at version has not been logged yet.
func (s *skillsSync) once(kind, label string, version int) bool {
	k := fmt.Sprintf("%s %s@%d", kind, label, version)
	if s.logged[k] {
		return false
	}
	s.logged[k] = true
	return true
}

func newSkillsSync(window time.Duration) *skillsSync {
	return &skillsSync{deb: newDebouncer(window), logged: map[string]bool{}}
}

// skillsPass pushes settled local units and pulls newer server versions for
// user scope, every project dir in projects and (pull only) org scope.
func (d *Daemon) skillsPass(projects map[string]string) {
	if d.skills == nil {
		return
	}
	s, err := skillsync.New(d.client, d.home, func(w string) { d.log.Printf("skills: %s", w) })
	if err != nil {
		d.log.Printf("skills: %v", err)
		return
	}
	s.Host = d.host
	dirs := make([]string, 0, len(projects))
	for dir := range projects {
		dirs = append(dirs, dir)
	}
	sort.Strings(dirs)
	targets, _ := skillsync.Targets("", "user,org", d.home, "")
	for _, dir := range dirs {
		t, _ := skillsync.Targets("", "project", d.home, dir)
		targets = append(targets, t...)
	}
	remotes, err := d.client.ListBundles(client.BundleFilter{})
	if err != nil {
		d.log.Printf("skills: list failed: %v", err)
		return
	}
	heads := map[client.BundleKey]api.Bundle{}
	for _, r := range remotes {
		heads[client.BundleKey{Scope: string(r.Scope), Agent: r.Agent, Project: r.Project, Name: r.Name}] = r
	}
	now := time.Now()
	for _, t := range targets {
		local := map[string]api.Bundle{}
		blobs := map[string]map[string]string{}
		if t.Scope != "org" {
			units, _ := t.Root.Units()
			for _, u := range units {
				b, bl, err := s.Build(t, u)
				if err != nil || len(b.Files) == 0 {
					continue
				}
				local[u.Name], blobs[u.Name] = b, bl
			}
		}
		// Pull newer server versions and remove units deleted on the server.
		for _, n := range s.Names(t) {
			if _, ok := heads[t.Key(n)]; ok {
				continue
			}
			res, err := s.Remove(t, n, false, false)
			if err != nil {
				d.log.Printf("skills: remove %s: %v", t.Label(n), err)
			} else if len(res.Deleted) > 0 || len(res.Conflicts) > 0 {
				d.log.Printf("skills removed %s (deleted on server): %d files, %d modified kept", t.Label(n), len(res.Deleted), len(res.Conflicts))
			}
		}
		for _, r := range remotes {
			if string(r.Scope) != t.Scope || r.Agent != t.Agent || r.Project != t.Project {
				continue
			}
			entry := s.Entry(t, r.Name)
			lb, exists := local[r.Name]
			modified := exists && manifestHash(bundle.Manifest(lb)) != manifestHash(entry.Manifest)
			label := t.Label(r.Name)
			switch decidePull(t.Scope, entry, r.Version, exists, modified) {
			case pullConflict:
				if d.skills.once("conflict", label, r.Version) {
					d.log.Printf("skills conflict %s: server has v%d, local files modified; run `stift pull --skills` to resolve", label, r.Version)
				}
			case pullApply:
				res, err := s.Pull(t, r, t.Scope == "org", false)
				if err != nil {
					d.log.Printf("skills: pull %s: %v", label, err)
					continue
				}
				d.log.Printf("skills pulled %s v%d: %d written, %d deleted", label, r.Version, len(res.Written), len(res.Deleted))
				delete(local, r.Name) // now in sync; do not push it back
				d.skills.deb.Forget(label)
			}
		}
		// Push local units that changed since the last sync and have settled.
		names := make([]string, 0, len(local))
		for n := range local {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			b, label := local[n], t.Label(n)
			entry := s.Entry(t, n)
			if skillsync.Unchanged(entry, b) {
				d.skills.deb.Forget(label)
				continue
			}
			if !d.skills.deb.Observe(label, manifestHash(bundle.Manifest(b)), now) {
				continue
			}
			version, err := s.Push(t, b, blobs[n], false)
			if err != nil {
				if errors.Is(err, client.ErrStale) {
					if d.skills.once("stale", label, entry.Version) {
						d.log.Printf("skills stale %s: server moved past v%d; run `stift pull --skills` to merge", label, entry.Version)
					}
				} else {
					d.log.Printf("skills: push %s: %v", label, err)
				}
				continue
			}
			d.skills.deb.Forget(label)
			d.log.Printf("skills pushed %s v%d (%d files)", label, version, len(b.Files))
		}
	}
}
