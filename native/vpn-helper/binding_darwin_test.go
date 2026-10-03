//go:build darwin

package main

import "syscall"

func readInterfaceOption(raw syscall.RawConn) (int, error) {
	var value int
	var optionError error
	err := raw.Control(func(fd uintptr) {
		value, optionError = syscall.GetsockoptInt(int(fd), syscall.IPPROTO_IP, interfaceSocketOption)
	})
	if err != nil {
		return 0, err
	}
	return value, optionError
}
