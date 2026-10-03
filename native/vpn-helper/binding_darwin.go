//go:build darwin

package main

import (
	"errors"
	"syscall"
)

const interfaceSocketOption = 25 // IP_BOUND_IF

func supportedPlatform() bool            { return true }
func eligibleInterface(name string) bool { return utunName.MatchString(name) }

func bindInterface(raw syscall.RawConn, index int) error {
	if index < 1 || index > 0xffffff {
		return errors.New("invalid interface index")
	}
	var optionError error
	err := raw.Control(func(fd uintptr) {
		optionError = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_IP, interfaceSocketOption, index)
	})
	if err != nil {
		return err
	}
	return optionError
}
