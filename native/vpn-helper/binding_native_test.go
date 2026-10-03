//go:build darwin || windows

package main

import (
	"context"
	"net"
	"syscall"
	"testing"
	"time"
)

func TestNativeSocketBindsInterfaceAndIPv4SourceBeforeConnect(t *testing.T) {
	interfaces, err := net.Interfaces()
	if err != nil {
		t.Fatal(err)
	}
	index := 0
	for _, iface := range interfaces {
		if iface.Flags&net.FlagLoopback != 0 && iface.Flags&net.FlagUp != 0 {
			addresses, _ := iface.Addrs()
			for _, address := range addresses {
				ip, _, _ := net.ParseCIDR(address.String())
				if ip != nil && ip.String() == "127.0.0.1" {
					index = iface.Index
				}
			}
		}
	}
	if index == 0 {
		t.Fatal("no IPv4 loopback interface available for native binding proof")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			accepted <- conn
		}
	}()
	verified := false
	dialer := &net.Dialer{LocalAddr: &net.TCPAddr{IP: net.ParseIP("127.0.0.1")}, Control: func(network, _ string, raw syscall.RawConn) error {
		if network != "tcp4" {
			t.Errorf("unexpected socket family %s", network)
		}
		if err := bindInterface(raw, index); err != nil {
			return err
		}
		actual, err := readInterfaceOption(raw)
		if err != nil {
			return err
		}
		if actual != index {
			t.Errorf("OS binding option: got %d, want %d", actual, index)
		}
		verified = true
		return nil
	}}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, err := dialer.DialContext(ctx, "tcp4", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if !verified || conn.LocalAddr().(*net.TCPAddr).IP.String() != "127.0.0.1" {
		t.Fatal("interface/source was not bound before connect")
	}
	select {
	case peer := <-accepted:
		peer.Close()
	case <-ctx.Done():
		t.Fatal("bound native connection did not arrive")
	}
}

func TestNonexistentInterfaceNeverFallsBackToDefaultRoute(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	dialer := &net.Dialer{LocalAddr: &net.TCPAddr{IP: net.ParseIP("127.0.0.1")}, Control: func(_ string, _ string, raw syscall.RawConn) error { return bindInterface(raw, 0xffffff) }}
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	conn, err := dialer.DialContext(ctx, "tcp4", listener.Addr().String())
	if conn != nil {
		conn.Close()
	}
	if err == nil {
		t.Fatal("nonexistent interface silently fell back to loopback/default route")
	}
}
