// Package service installs and controls stift's background sync worker as a
// per-user OS service (systemd on Linux, launchd on macOS), falling back to a
// detached self-spawned process tracked by a pidfile where neither is present.
package service

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

const (
	serviceName  = "stift"
	launchdLabel = "sh.stift.daemon"
)

// Install installs and starts the background sync service.
func Install() error {
	switch {
	case hasUserSystemd():
		return systemdInstall()
	case hasLaunchd():
		return launchdInstall()
	default:
		return fallbackSpawn()
	}
}

// Uninstall stops and removes the background sync service.
func Uninstall() error {
	switch {
	case hasUserSystemd() && systemdInstalled():
		_ = run("systemctl", "--user", "disable", "--now", serviceName+".service")
		if p, err := systemdUnitPath(); err == nil {
			_ = os.Remove(p)
		}
		_ = run("systemctl", "--user", "daemon-reload")
		return nil
	case hasLaunchd() && launchdInstalled():
		uid := os.Getuid()
		_ = run("launchctl", "bootout", fmt.Sprintf("gui/%d/%s", uid, launchdLabel))
		if p, err := launchdPlistPath(); err == nil {
			_ = os.Remove(p)
		}
		return nil
	default:
		return fallbackStop()
	}
}

// Restart restarts the background sync service.
func Restart() error {
	switch {
	case hasUserSystemd() && systemdInstalled():
		return run("systemctl", "--user", "restart", serviceName+".service")
	case hasLaunchd() && launchdInstalled():
		uid := os.Getuid()
		return run("launchctl", "kickstart", "-k", fmt.Sprintf("gui/%d/%s", uid, launchdLabel))
	default:
		_ = fallbackStop()
		return fallbackSpawn()
	}
}

// Status returns a human-readable one-line status of the service.
func Status() (string, error) {
	switch {
	case hasUserSystemd() && systemdInstalled():
		out, _ := exec.Command("systemctl", "--user", "is-active", serviceName+".service").Output()
		return "systemd (user): " + orUnknown(strings.TrimSpace(string(out))), nil
	case hasLaunchd() && launchdInstalled():
		return "launchd: installed", nil
	default:
		return fallbackStatus()
	}
}

// ---- systemd (Linux) ----

func hasUserSystemd() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		return false
	}
	return exec.Command("systemctl", "--user", "show-environment").Run() == nil
}

func systemdUnitPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "systemd", "user", serviceName+".service"), nil
}

func systemdInstalled() bool {
	p, err := systemdUnitPath()
	if err != nil {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}

func systemdInstall() error {
	exe, err := binPath()
	if err != nil {
		return err
	}
	path, err := systemdUnitPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	unit := fmt.Sprintf(`[Unit]
Description=stift session sync
After=network-online.target

[Service]
ExecStart=%s daemon
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`, exe)
	if err := os.WriteFile(path, []byte(unit), 0o644); err != nil {
		return err
	}
	if err := run("systemctl", "--user", "daemon-reload"); err != nil {
		return err
	}
	return run("systemctl", "--user", "enable", "--now", serviceName+".service")
}

// ---- launchd (macOS) ----

func hasLaunchd() bool {
	if runtime.GOOS != "darwin" {
		return false
	}
	_, err := exec.LookPath("launchctl")
	return err == nil
}

func launchdPlistPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents", launchdLabel+".plist"), nil
}

func launchdInstalled() bool {
	p, err := launchdPlistPath()
	if err != nil {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}

func launchdInstall() error {
	exe, err := binPath()
	if err != nil {
		return err
	}
	path, err := launchdPlistPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>%s</string>
	<key>ProgramArguments</key>
	<array>
		<string>%s</string>
		<string>daemon</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
</dict>
</plist>
`, launchdLabel, exe)
	if err := os.WriteFile(path, []byte(plist), 0o644); err != nil {
		return err
	}
	uid := os.Getuid()
	// bootout first so a re-install picks up a changed path (ignore errors).
	_ = run("launchctl", "bootout", fmt.Sprintf("gui/%d/%s", uid, launchdLabel))
	if err := run("launchctl", "bootstrap", fmt.Sprintf("gui/%d", uid), path); err != nil {
		return err
	}
	_ = run("launchctl", "enable", fmt.Sprintf("gui/%d/%s", uid, launchdLabel))
	return run("launchctl", "kickstart", "-k", fmt.Sprintf("gui/%d/%s", uid, launchdLabel))
}

// ---- detached-process fallback ----

func fallbackSpawn() error {
	if _, ok := runningPid(); ok {
		return nil // already running
	}
	exe, err := binPath()
	if err != nil {
		return err
	}
	lp, err := logPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(lp), 0o700); err != nil {
		return err
	}
	logf, err := os.OpenFile(lp, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer logf.Close()

	cmd := exec.Command(exe, "daemon")
	cmd.Stdout = logf
	cmd.Stderr = logf
	cmd.SysProcAttr = detachAttr()
	if err := cmd.Start(); err != nil {
		return err
	}
	pp, err := pidfilePath()
	if err != nil {
		return err
	}
	if err := os.WriteFile(pp, []byte(strconv.Itoa(cmd.Process.Pid)), 0o600); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func fallbackStop() error {
	pid, ok := runningPid()
	if pp, err := pidfilePath(); err == nil {
		defer os.Remove(pp)
	}
	if !ok {
		return nil
	}
	return terminate(pid)
}

func fallbackStatus() (string, error) {
	if pid, ok := runningPid(); ok {
		return fmt.Sprintf("background process: running (pid %d)", pid), nil
	}
	return "background process: not running", nil
}

// ---- shared helpers ----

func binPath() (string, error) {
	return os.Executable()
}

func stateDir() (string, error) {
	dir, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "stift"), nil
}

func pidfilePath() (string, error) {
	d, err := stateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "daemon.pid"), nil
}

func logPath() (string, error) {
	d, err := stateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "daemon.log"), nil
}

func runningPid() (int, bool) {
	pp, err := pidfilePath()
	if err != nil {
		return 0, false
	}
	data, err := os.ReadFile(pp)
	if err != nil {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return 0, false
	}
	if !processAlive(pid) {
		return 0, false
	}
	return pid, true
}

func run(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func orUnknown(s string) string {
	if s == "" {
		return "unknown"
	}
	return s
}
