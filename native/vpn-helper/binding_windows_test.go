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
	// Windows setsockopt requires network byte order, but getsockopt reports
	// the interface index in host byte order. Swapping the readback again makes
	// a bound loopback index of 1 appear as 16777216 in the native socket test.
	return value, optionError
}

func TestWindowsInterfaceIndexUsesNetworkByteOrder(t *testing.T) {
	for index, expected := range map[int]int{1: 0x01000000, 26: 0x1a000000, 0x123456: 0x56341200} {
		if actual := networkOrder(index); actual != expected {
			t.Errorf("IP_UNICAST_IF write value for index %d: got %#x, want %#x", index, actual, expected)
		}
	}
}
