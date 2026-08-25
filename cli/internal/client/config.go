// Package client implements the stift API client and its local config.
package client

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Config is the client's saved connection (~/.config/stift/config.json).
type Config struct {
	Server string `json:"server"`
	Token  string `json:"token"`
}

func configPath() (string, error) {
	if p := os.Getenv("STIFT_CONFIG"); p != "" {
		return p, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "stift", "config.json"), nil
}

// Link records that a local directory maps to a project id on the server, so
// the daemon knows to reconcile (pull) that project into that directory. This
// is an explicit user override written by `stift link`; automatic reconcile
// does not depend on it.
type Link struct {
	Dir       string `json:"dir"`
	ProjectID string `json:"project_id"`
}

func linksPath() (string, error) {
	p, err := configPath()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(p), "links.json"), nil
}

// LoadLinks reads the saved project links; a missing file yields no links.
func LoadLinks() ([]Link, error) {
	path, err := linksPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var links []Link
	if err := json.Unmarshal(data, &links); err != nil {
		return nil, err
	}
	return links, nil
}

// SaveLinks writes the project links, replacing any existing file.
func SaveLinks(links []Link) (string, error) {
	path, err := linksPath()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	data, err := json.MarshalIndent(links, "", "  ")
	if err != nil {
		return "", err
	}
	return path, os.WriteFile(path, data, 0o600)
}

// LoadConfig reads the saved config; STIFT_SERVER and STIFT_TOKEN
// environment variables override saved values.
func LoadConfig() (Config, error) {
	var cfg Config
	path, err := configPath()
	if err == nil {
		if data, err := os.ReadFile(path); err == nil {
			json.Unmarshal(data, &cfg)
		}
	}
	if v := os.Getenv("STIFT_SERVER"); v != "" {
		cfg.Server = v
	}
	if v := os.Getenv("STIFT_TOKEN"); v != "" {
		cfg.Token = v
	}
	return cfg, nil
}

func SaveConfig(cfg Config) (string, error) {
	path, err := configPath()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return "", err
	}
	return path, os.WriteFile(path, data, 0o600)
}

// Require returns a ready API client or an actionable error.
func Require() (*Client, error) {
	cfg, err := LoadConfig()
	if err != nil {
		return nil, err
	}
	if cfg.Server == "" || cfg.Token == "" {
		return nil, fmt.Errorf("not logged in: run `stift login <server-url> --token <token>` " +
			"or set STIFT_SERVER and STIFT_TOKEN")
	}
	return New(cfg.Server, cfg.Token), nil
}
