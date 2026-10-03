//go:build !darwin && !windows

package main

import (
	"errors"
	"syscall"
)

func supportedPlatform() bool       { return false }
func eligibleInterface(string) bool { return false }
func bindInterface(syscall.RawConn, int) error {
	return errors.New("VPN interface binding is unsupported on this platform")
}
