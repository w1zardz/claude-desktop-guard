package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCONNECTAuthority(t *testing.T) {
	for _, input := range []string{"api.anthropic.com:443", "1.1.1.1:443", "API.ANTHROPIC.COM:443"} {
		if _, err := parseAuthority(input); err != nil {
			t.Fatalf("valid authority %q: %v", input, err)
		}
	}
	for _, input := range []string{"", "api.anthropic.com", "api.anthropic.com:80", "api.anthropic.com:0443", "[2606:4700:4700::1111]:443", "[::1]:443", "127.0.0.1:443", "10.0.0.1:443", "172.16.0.1:443", "192.168.1.1:443", "100.64.0.1:443", "169.254.0.1:443", "0.0.0.0:443", "198.18.0.1:443", "192.0.2.1:443", "203.0.113.1:443", "224.0.0.1:443", "localhost:443", "host.local:443", "user@api.anthropic.com:443", "api.anthropic.com:443/path", "api.anthropic.com:443\r\nHost: evil", "2130706433:443", "0x7f000001:443", "127.1:443", "api.anthropic.com.:443"} {
		if _, err := parseAuthority(input); err == nil {
			t.Errorf("unsafe authority accepted: %q", input)
		}
	}
}

func TestExactInterfaceTuple(t *testing.T) {
	selected := selection{Name: "utun4", Index: 26, Address: "10.8.1.2"}
	devices := []device{{name: "utun4", index: 26, up: true, addresses: []string{"10.8.1.2"}}}
	eligible := func(name string) bool { return name == "utun4" }
	if err := validateSelection(selected, devices, eligible); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []selection{
		{Name: "utun5", Index: 26, Address: selected.Address},
		{Name: selected.Name, Index: 27, Address: selected.Address},
		{Name: selected.Name, Index: 26, Address: "10.8.1.3"},
		{Name: selected.Name, Index: 0, Address: selected.Address},
		{Name: selected.Name, Index: 0x1000000, Address: selected.Address},
		{Name: selected.Name, Index: 26, Address: "::1"},
		{Name: selected.Name, Index: 26, Address: "169.254.1.1"},
	} {
		if validateSelection(bad, devices, eligible) == nil {
			t.Fatalf("changed tuple accepted: %+v", bad)
		}
	}
	devices[0].up = false
	if validateSelection(selected, devices, eligible) == nil {
		t.Fatal("down interface accepted")
	}
	devices[0].up = true
	devices[0].name = "en0"
	if validateSelection(selected, devices, eligible) == nil {
		t.Fatal("same index reused by different interface accepted")
	}
}

func dnsFixture(question string, answers []dnsRecord) []byte {
	status := 0
	body, _ := json.Marshal(dnsResponse{Status: &status, Question: []dnsRecord{{Name: question, Type: 1}}, Answer: answers})
	return body
}

func TestDoHARecordsAndRebinding(t *testing.T) {
	host := "api.anthropic.com"
	good := dnsFixture(host+".", []dnsRecord{{Name: host, Type: 5, Data: "edge.public-cdn.net."}, {Name: "edge.public-cdn.net.", Type: 1, Data: "1.1.1.1"}, {Name: "edge.public-cdn.net.", Type: 1, Data: "10.0.0.1"}, {Name: host, Type: 1, Data: "1.1.1.1"}, {Name: host, Type: 28, Data: "2606:4700:4700::1111"}})
	addresses, err := parseDNSAnswer(host, good)
	if err != nil || len(addresses) != 1 || addresses[0] != "1.1.1.1" {
		t.Fatalf("CNAME chain/public IPv4 filtering failed: %v %v", addresses, err)
	}
	for _, body := range [][]byte{
		dnsFixture("different.example.com", []dnsRecord{{Name: host, Type: 1, Data: "1.1.1.1"}}),
		dnsFixture(host, []dnsRecord{{Name: host, Type: 1, Data: "127.0.0.1"}}),
		dnsFixture(host, []dnsRecord{{Name: host, Type: 1, Data: "::ffff:1.1.1.1"}}),
		dnsFixture(host, []dnsRecord{{Name: "unrelated.example.com", Type: 1, Data: "1.1.1.1"}}),
		dnsFixture(host, []dnsRecord{{Name: host, Type: 5, Data: "router.local"}, {Name: "router.local", Type: 1, Data: "1.1.1.1"}}),
		[]byte(`{"Status":3,"Question":[{"name":"api.anthropic.com","type":1}]}`),
		[]byte(`{"Status":0,"TC":true,"Question":[{"name":"api.anthropic.com","type":1}]}`),
		[]byte(`{"Question":[{"name":"api.anthropic.com","type":1}]}`),
		append(good, []byte(` {}`)...),
		[]byte(strings.Repeat("x", maxDNSBody+1)),
	} {
		if _, err := parseDNSAnswer(host, body); err == nil {
			t.Errorf("unsafe or mismatched DoH response accepted: %s", string(body[:min(len(body), 150)]))
		}
	}
}

func TestTerminateClosesTrackedAndRejectsLateSockets(t *testing.T) {
	g := newGateway(selection{})
	left, right := net.Pipe()
	defer right.Close()
	if _, err := g.track(left); err != nil {
		t.Fatal(err)
	}
	g.terminate(errors.New("test stop"))
	if g.ctx.Err() != context.Canceled {
		t.Fatal("pending dial context not cancelled")
	}
	if _, err := right.Write([]byte("x")); err == nil {
		t.Fatal("active connection survived terminate")
	}
	late, peer := net.Pipe()
	defer peer.Close()
	if _, err := g.track(late); err == nil {
		t.Fatal("late socket survived terminate")
	}
	if _, err := peer.Write([]byte("x")); err == nil {
		t.Fatal("late socket not closed")
	}
	if len(g.conns) != 0 {
		t.Fatal("connection registry retained stopped connections")
	}
}

func TestWatchdogStopsChangedTupleWithinOneSecond(t *testing.T) {
	g := newGateway(selection{Name: "not-a-real-interface", Index: 0xffffff, Address: "10.8.1.2"})
	defer g.terminate(nil)
	go g.watchdog()
	select {
	case <-g.ctx.Done():
	case <-time.After(950 * time.Millisecond):
		t.Fatal("changed interface watchdog exceeded one second")
	}
}

func TestInvalidRequestsNeverReachDial(t *testing.T) {
	g := newGateway(selection{})
	defer g.terminate(nil)
	for _, target := range []string{"127.0.0.1:443", "[2606:4700:4700::1111]:443", "host.local:443", "api.anthropic.com:80"} {
		request := httptest.NewRequest(http.MethodConnect, "http://example.com", nil)
		request.RequestURI = target
		writer := httptest.NewRecorder()
		g.ServeHTTP(writer, request)
		if writer.Code != http.StatusBadRequest || len(g.conns) != 0 || g.ctx.Err() != nil {
			t.Fatalf("invalid target reached native transport: %s, status %d", target, writer.Code)
		}
	}
	writer := httptest.NewRecorder()
	g.ServeHTTP(writer, httptest.NewRequest(http.MethodGet, "http://example.com", nil))
	if writer.Code != http.StatusMethodNotAllowed {
		t.Fatal("plaintext forwarding allowed")
	}
}

func TestLinuxAndUnsupportedPlatformsRefuseService(t *testing.T) {
	if supportedPlatform() {
		t.Skip("supported OS")
	}
	if err := run([]string{"--list"}, strings.NewReader(""), &strings.Builder{}); err == nil {
		t.Fatal("unsupported platform started helper")
	}
}
