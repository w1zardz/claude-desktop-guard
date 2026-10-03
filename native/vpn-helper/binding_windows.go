//go:build windows

package main

import (
	"errors"
	"strings"
	"syscall"
)

const interfaceSocketOption = 31 // IP_UNICAST_IF, value must be network byte order.

func supportedPlatform() bool            { return true }
func eligibleInterface(name string) bool { return strings.HasPrefix(strings.ToLower(name), "amnezia") }

func networkOrder(index int) int {
	x := uint32(index)
	return int((x>>24)&0xff | (x>>8)&0xff00 | (x<<8)&0xff0000 | (x<<24)&0xff000000)
}

func bindInterface(raw syscall.RawConn, index int) error {
	if index < 1 || index > 0xffffff {
		return errors.New("invalid interface index")
	}
	var optionError error
	err := raw.Control(func(fd uintptr) {
		optionError = syscall.SetsockoptInt(syscall.Handle(fd), syscall.IPPROTO_IP, interfaceSocketOption, networkOrder(index))
	})
	if err != nil {
		return err
	}
	return optionError
}
