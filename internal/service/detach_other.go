//go:build !unix

package service

import (
	"os"
	"syscall"
)

// detachAttr has no portable detach flags off unix.
func detachAttr() *syscall.SysProcAttr {
	return nil
}

// processAlive best-effort checks whether pid exists.
func processAlive(pid int) bool {
	proc, err := os.FindProcess(pid)
	return err == nil && proc != nil
}

// terminate stops the process.
func terminate(pid int) error {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Kill()
}
