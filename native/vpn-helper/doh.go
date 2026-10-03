package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxDNSBody = 64 * 1024

type dnsRecord struct {
	Name string `json:"name"`
	Type int    `json:"type"`
	Data string `json:"data"`
}

type dnsResponse struct {
	Status   *int        `json:"Status"`
	TC       bool        `json:"TC"`
	Question []dnsRecord `json:"Question"`
	Answer   []dnsRecord `json:"Answer"`
}

func dnsName(value string) string { return strings.ToLower(strings.TrimSuffix(value, ".")) }

func parseDNSAnswer(host string, body []byte) ([]string, error) {
	if len(body) > maxDNSBody || !publicHostname(host) {
		return nil, errors.New("invalid DNS response size or question")
	}
	var response dnsResponse
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := decoder.Decode(&response); err != nil {
		return nil, errors.New("malformed DNS JSON")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, errors.New("trailing DNS JSON data")
	}
	if response.Status == nil || *response.Status != 0 || response.TC || len(response.Question) != 1 || response.Question[0].Type != 1 || dnsName(response.Question[0].Name) != host || len(response.Answer) > 64 {
		return nil, errors.New("DNS response does not match requested A question")
	}
	allowedNames := map[string]bool{host: true}
	for depth := 0; depth < 8; depth++ {
		changed := false
		for _, record := range response.Answer {
			if record.Type == 5 && allowedNames[dnsName(record.Name)] {
				alias := dnsName(record.Data)
				if !publicHostname(alias) {
					return nil, errors.New("DNS alias is not a public hostname")
				}
				if !allowedNames[alias] {
					allowedNames[alias] = true
					changed = true
				}
			}
		}
		if !changed {
			break
		}
	}
	addresses := make([]string, 0)
	seen := make(map[string]bool)
	for _, record := range response.Answer {
		if record.Type != 1 || !allowedNames[dnsName(record.Name)] || publicIPv4(record.Data) == nil || seen[record.Data] {
			continue
		}
		seen[record.Data] = true
		addresses = append(addresses, record.Data)
		if len(addresses) > 16 {
			return nil, errors.New("too many public DNS answers")
		}
	}
	if len(addresses) == 0 {
		return nil, errors.New("DNS returned no public IPv4 A records")
	}
	return addresses, nil
}

func (g *gateway) resolve(ctx context.Context, host string) ([]string, error) {
	if publicIPv4(host) != nil {
		return []string{host}, nil
	}
	if !publicHostname(host) {
		return nil, errors.New("invalid DNS hostname")
	}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			if network != "tcp" || address != "cloudflare-dns.com:443" {
				return nil, errors.New("unexpected DoH endpoint")
			}
			return g.dialBound(ctx, "1.1.1.1")
		},
		TLSClientConfig:   &tls.Config{ServerName: "cloudflare-dns.com", MinVersion: tls.VersionTLS12},
		DisableKeepAlives: true, ForceAttemptHTTP2: false,
		TLSHandshakeTimeout: 8 * time.Second, ResponseHeaderTimeout: 8 * time.Second,
		MaxResponseHeaderBytes: 16 * 1024,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 8 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	endpoint := "https://cloudflare-dns.com/dns-query?" + url.Values{"name": {host}, "type": {"A"}}.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/dns-json")
	request.Header.Set("Accept-Encoding", "identity")
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("interface-bound DNS-over-HTTPS failed")
	}
	defer response.Body.Close()
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if response.StatusCode != http.StatusOK || err != nil || (mediaType != "application/dns-json" && mediaType != "application/json") || (response.Header.Get("Content-Encoding") != "" && response.Header.Get("Content-Encoding") != "identity") {
		return nil, errors.New("DoH endpoint must return uncompressed JSON without redirect")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxDNSBody+1))
	if err != nil {
		return nil, errors.New("unable to read DNS response")
	}
	return parseDNSAnswer(host, body)
}
