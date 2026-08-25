package daemon

import (
	"os"

	"github.com/stift-sh/stift/engine/api"
	"github.com/stift-sh/stift/engine/archive"
	"github.com/stift-sh/stift/internal/agents"
	"github.com/stift-sh/stift/internal/client"
	"github.com/stift-sh/stift/internal/gitrepo"
)

// PushSession packs one locally-detected session and uploads it, tagging it
// with the project identity (repo name + git remote) derived from its project
// directory. Shared by `stift push` and the background daemon.
func PushSession(c *client.Client, s agents.LocalSession, host string) (api.PushResult, error) {
	tmp, err := os.CreateTemp("", "stift-push-*.tar.gz")
	if err != nil {
		return api.PushResult{}, err
	}
	defer os.Remove(tmp.Name())

	n, err := archive.Pack(tmp, s.BaseDir, s.Files)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return api.PushResult{}, err
	}

	projectID, repo := gitrepo.Identity(s.Project)
	return c.Push(api.Session{
		Key:       s.Key(host),
		Agent:     s.Agent,
		SessionID: s.SessionID,
		Project:   s.Project,
		ProjectID: projectID,
		Repo:      repo,
		Host:      host,
		Title:     s.Title,
		Base:      s.Base,
		Files:     n,
		ModTime:   s.ModTime,
	}, tmp.Name())
}
