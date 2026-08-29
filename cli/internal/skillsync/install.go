package skillsync

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/stift-sh/stift/internal/agents"
	"github.com/stift-sh/stift/internal/api"
	"github.com/stift-sh/stift/internal/bundle"
)

// ErrSubscribed is returned by Install when the destination is the symlink
// that `stift pull --skills --scope org` created for the same unit.
var ErrSubscribed = errors.New("already subscribed via org scope")

// ErrModified is returned by Install with upgrade when the installed copy
// no longer matches what was recorded at install time.
var ErrModified = errors.New("installed copy was modified locally")

// InstallOptions controls Install.
type InstallOptions struct {
	Replace bool // turn an org-scope subscription (symlink) into a copy
	Upgrade bool // re-copy over an existing install
	Force   bool // overwrite local modifications
}

// InstallResult describes what Install did.
type InstallResult struct {
	Dir      string
	Version  int
	Apply    bundle.ApplyResult
	Replaced bool // a subscription link was removed
	Upgraded bool // an earlier install was on disk
	Previous int  // version of that earlier install
}

// Install copies an org unit into the agent's own user config directory as
// a real directory (or file) the user owns and may edit, and records the
// provenance in the state file. This is the "fork the company skill" path;
// subscribing (pull --scope org) is the mirror. Nothing is reported to the
// server here; see ReportInstall.
func (s *Syncer) Install(agent string, remote api.Bundle, opt InstallOptions) (InstallResult, error) {
	var res InstallResult
	name := remote.Name
	if !agents.ValidUnitName(name) || !strings.Contains(name, "/") {
		return res, fmt.Errorf("cannot install %q: only nested units such as skills/<name> can be installed", name)
	}
	root, ok := UserConfigRoot(s.Home, agent)
	if !ok {
		return res, fmt.Errorf("%s: no user config directory known", agent)
	}
	paths := bundle.Paths(remote)
	dir := agents.UnitDir(root.BaseDir, name, paths)
	// The path a subscription would have linked: the unit dir, or the single
	// file of a file unit.
	linkPath := filepath.Join(root.BaseDir, filepath.FromSlash(name))
	if dir != filepath.Join(root.BaseDir, filepath.FromSlash(name)) && len(paths) == 1 {
		linkPath = filepath.Join(dir, paths[0])
	}
	if cur, err := os.Readlink(linkPath); err == nil {
		if !strings.HasPrefix(cur, OrgDir(s.Home, agent)+string(filepath.Separator)) {
			return res, fmt.Errorf("%s is a symlink to %s; remove it first", linkPath, cur)
		}
		if !opt.Replace {
			return res, fmt.Errorf("%w; `stift skills install %s --replace` turns it into a copy", ErrSubscribed, name)
		}
		if err := os.Remove(linkPath); err != nil {
			return res, err
		}
		res.Replaced = true
	}
	prev := s.State.GetInstall(s.Server, agent, name)
	var base map[string]string
	if prev.Version > 0 {
		if !opt.Upgrade && !opt.Force {
			return res, fmt.Errorf("%s is already installed (v%d); `stift skills install %s --upgrade` re-copies it", name, prev.Version, name)
		}
		res.Upgraded, res.Previous = true, prev.Version
		base = prev.Manifest
		if !opt.Force {
			if modified, err := installModified(dir, prev.Manifest); err != nil {
				return res, err
			} else if modified {
				return res, fmt.Errorf("%w; `--force` overwrites it", ErrModified)
			}
		}
	}
	apply, err := bundle.Apply(remote, s.fetch, dir, base, opt.Force, false)
	if err != nil {
		return res, err
	}
	res.Dir, res.Version, res.Apply = dir, remote.Version, apply
	manifest := bundle.Manifest(remote)
	for _, p := range apply.Conflicts {
		if sha, ok := base[p]; ok {
			manifest[p] = sha
		} else {
			delete(manifest, p)
		}
	}
	err = s.State.SetInstall(s.Server, agent, name, bundle.InstallEntry{From: "org", Version: remote.Version, Manifest: manifest})
	return res, err
}

// installModified reports whether any file recorded at install time differs
// from, or is missing on, disk.
func installModified(dir string, manifest map[string]string) (bool, error) {
	for p, sha := range manifest {
		cur, exists, err := bundle.LocalSHA(filepath.Join(dir, filepath.FromSlash(p)))
		if err != nil {
			return false, err
		}
		if !exists || cur != sha {
			return true, nil
		}
	}
	return false, nil
}

// Report tells the server where a unit now is on this machine. Failures
// are non-fatal for callers (reporting only) and returned for a warning.
func (s *Syncer) Report(agent, name string, version int, from api.InstallReportFrom) error {
	return s.Client.ReportInstall(api.InstallReport{Agent: agent, Name: name, Version: version, Host: s.Host, From: from})
}
