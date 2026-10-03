package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"syscall"
	"time"
)

type gateway struct {
	selected selection
	ctx      context.Context
	cancel   context.CancelFunc
	mu       sync.Mutex
	closed   bool
	conns    map[net.Conn]struct{}
	fatal    chan error
	slots    chan struct{}
}

func newGateway(selected selection) *gateway {
	ctx, cancel := context.WithCancel(context.Background())
	return &gateway{selected: selected, ctx: ctx, cancel: cancel, conns: make(map[net.Conn]struct{}), fatal: make(chan error, 1), slots: make(chan struct{}, 32)}
}

func (g *gateway) terminate(reason error) {
	g.mu.Lock()
	if g.closed {
		g.mu.Unlock()
		return
	}
	g.closed = true
	connections := make([]net.Conn, 0, len(g.conns))
	for conn := range g.conns {
		connections = append(connections, conn)
	}
	g.conns = make(map[net.Conn]struct{})
	g.mu.Unlock()
	if reason != nil {
		select {
		case g.fatal <- reason:
		default:
		}
	}
	// Cancel pending DialContext calls before closing every already-created socket.
	g.cancel()
	for _, conn := range connections {
		conn.Close()
	}
}

type trackedConn struct {
	net.Conn
	owner *gateway
}

func (conn *trackedConn) Close() error {
	err := conn.Conn.Close()
	conn.owner.mu.Lock()
	delete(conn.owner.conns, conn.Conn)
	conn.owner.mu.Unlock()
	return err
}

func (g *gateway) track(conn net.Conn) (net.Conn, error) {
	g.mu.Lock()
	if g.closed {
		g.mu.Unlock()
		conn.Close()
		return nil, errors.New("VPN helper is stopped")
	}
	g.conns[conn] = struct{}{}
	g.mu.Unlock()
	return &trackedConn{Conn: conn, owner: g}, nil
}

type trackedListener struct {
	net.Listener
	owner *gateway
}

func (listener *trackedListener) Accept() (net.Conn, error) {
	conn, err := listener.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return listener.owner.track(conn)
}

func (g *gateway) check() error {
	if err := g.selected.check(); err != nil {
		g.terminate(errors.New("selected VPN interface changed or disappeared"))
		return err
	}
	if g.ctx.Err() != nil {
		return errors.New("VPN helper is stopped")
	}
	return nil
}

func (g *gateway) dialBound(ctx context.Context, address string) (net.Conn, error) {
	if publicIPv4(address) == nil {
		return nil, errors.New("outgoing transport requires a public numeric IPv4")
	}
	if err := g.check(); err != nil {
		return nil, err
	}
	dialer := &net.Dialer{
		Timeout:   8 * time.Second,
		LocalAddr: &net.TCPAddr{IP: sourceIPv4(g.selected.Address), Port: 0},
		Control: func(network, address string, raw syscall.RawConn) error {
			if network != "tcp4" {
				return errors.New("only IPv4 sockets may be created")
			}
			if err := g.check(); err != nil {
				return err
			}
			if err := bindInterface(raw, g.selected.Index); err != nil {
				g.terminate(errors.New("OS rejected VPN interface binding"))
				return errors.New("OS rejected VPN interface binding")
			}
			return nil
		},
	}
	// Numeric IPv4 plus tcp4 prevents Go from consulting any OS resolver.
	conn, err := dialer.DialContext(ctx, "tcp4", net.JoinHostPort(address, "443"))
	if err != nil {
		return nil, errors.New("interface-bound TCP connect failed")
	}
	if err := g.check(); err != nil {
		conn.Close()
		return nil, err
	}
	return g.track(conn)
}

func (g *gateway) watchdog() {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-g.ctx.Done():
			return
		case <-ticker.C:
			if g.check() != nil {
				return
			}
		}
	}
}

func (g *gateway) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Connection", "close")
	if request.Method != http.MethodConnect {
		http.Error(writer, "Only HTTPS CONNECT is supported", http.StatusMethodNotAllowed)
		return
	}
	if request.ProtoMajor != 1 || request.ProtoMinor > 1 || request.ContentLength > 0 || len(request.TransferEncoding) > 0 {
		http.Error(writer, "Invalid CONNECT request", http.StatusBadRequest)
		return
	}
	host, err := parseAuthority(request.RequestURI)
	if err != nil {
		http.Error(writer, "Invalid public IPv4 CONNECT target", http.StatusBadRequest)
		return
	}
	select {
	case g.slots <- struct{}{}:
		defer func() { <-g.slots }()
	default:
		http.Error(writer, "Tunnel concurrency limit reached", http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(g.ctx, 8*time.Second)
	defer cancel()
	addresses, err := g.resolve(ctx, host)
	if err != nil {
		http.Error(writer, "Interface-bound DNS unavailable", http.StatusBadGateway)
		return
	}
	upstream, err := g.dialBound(ctx, addresses[0])
	if err != nil {
		http.Error(writer, "Interface-bound tunnel unavailable", http.StatusBadGateway)
		return
	}
	defer upstream.Close()
	if g.check() != nil || ctx.Err() != nil {
		http.Error(writer, "VPN interface changed", http.StatusServiceUnavailable)
		return
	}
	hijacker, ok := writer.(http.Hijacker)
	if !ok {
		http.Error(writer, "CONNECT unavailable", http.StatusInternalServerError)
		return
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer client.Close()
	if g.check() != nil {
		return
	}
	client.SetDeadline(time.Time{})
	if _, err := buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	if buffered.Flush() != nil {
		return
	}
	done := make(chan struct{}, 2)
	go func() { io.Copy(upstream, buffered.Reader); done <- struct{}{} }()
	go func() { io.Copy(client, upstream); done <- struct{}{} }()
	<-done
	client.Close()
	upstream.Close()
	<-done
}
