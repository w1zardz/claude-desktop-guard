package main

import (
	"errors"
	"net"
	"regexp"
	"strings"
)

var dnsLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
var numericName = regexp.MustCompile(`^[0-9.]+$|^0x[0-9a-f]+$`)

func publicIPv4(value string) net.IP {
	ip := net.ParseIP(value)
	if ip == nil || ip.To4() == nil || strings.Contains(value, ":") || ip.String() != value {
		return nil
	}
	q := ip.To4()
	a, b, c := q[0], q[1], q[2]
	if a == 0 || a == 10 || a == 127 || a >= 224 ||
		(a == 100 && b >= 64 && b <= 127) || (a == 169 && b == 254) ||
		(a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) ||
		(a == 192 && b == 0 && (c == 0 || c == 2)) ||
		(a == 192 && b == 88 && c == 99) || (a == 198 && (b == 18 || b == 19)) ||
		(a == 198 && b == 51 && c == 100) || (a == 203 && b == 0 && c == 113) {
		return nil
	}
	return q
}

func publicHostname(value string) bool {
	if value == "" || len(value) > 253 || value != strings.ToLower(value) || !strings.Contains(value, ".") || strings.HasSuffix(value, ".") || numericName.MatchString(value) {
		return false
	}
	labels := strings.Split(value, ".")
	for _, label := range labels {
		if !dnsLabel.MatchString(label) {
			return false
		}
	}
	switch labels[len(labels)-1] {
	case "localhost", "local", "internal", "home", "lan", "test", "invalid", "example", "onion":
		return false
	}
	return true
}

func parseAuthority(authority string) (string, error) {
	if len(authority) > 260 || strings.ContainsAny(authority, "\r\n\t /\\@?#[]") {
		return "", errors.New("CONNECT target must be public IPv4 or DNS on port 443; IPv6 is unsupported")
	}
	host, port, err := net.SplitHostPort(authority)
	if err != nil || port != "443" || authority != host+":443" {
		return "", errors.New("CONNECT requires explicit port 443")
	}
	host = strings.ToLower(host)
	if net.ParseIP(host) != nil {
		if publicIPv4(host) == nil {
			return "", errors.New("private, reserved and IPv6 CONNECT targets are blocked")
		}
		return host, nil
	}
	if !publicHostname(host) {
		return "", errors.New("invalid public DNS target")
	}
	return host, nil
}
