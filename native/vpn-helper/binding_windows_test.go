//go:build windows

package main

import (
	"syscall"
	"testing"
)

func readInterfaceOption(raw syscall.RawConn) (int, error) {
	var value int
	var optionError error
	err := raw.Control(func(fd uintptr) {
		value, optionError = syscall.GetsockoptInt(syscall.Handle(fd), syscall.IPPROTO_IP, interfaceSocketOption)
	})
	if err != nil {
		return 0, err
	}
	return networkOrder(value), optionError
}

func TestWindowsInterfaceIndexUsesNetworkByteOrder(t *testing.T) {
	if networkOrder(26) != 0x1a000000 || networkOrder(0x123456) != 0x56341200 {
		t.Fatal("IP_UNICAST_IF index must be network byte order")
	}
}
