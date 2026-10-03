package main

import (
	"errors"
	"fmt"
	"net"
	"regexp"
	"sort"
	"strconv"
)

type selection struct {
	Name    string `json:"name"`
	Index   int    `json:"index"`
	Address string `json:"address"`
}

type device struct {
	name      string
	index     int
	up        bool
	addresses []string
}

var utunName = regexp.MustCompile(`^utun[0-9]+$`)

func sourceIPv4(address string) net.IP {
	ip := net.ParseIP(address)
	if ip == nil || ip.To4() == nil || ip.IsUnspecified() || ip.IsLoopback() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.To4()[0] == 0 || ip.To4()[0] >= 224 {
		return nil
	}
	if ip.String() != address {
		return nil
	}
	return ip.To4()
}

func (s selection) checkShape() error {
	if s.Name == "" || len(s.Name) > 128 || s.Index < 1 || s.Index > 0xffffff || sourceIPv4(s.Address) == nil {
		return errors.New("invalid selected interface tuple")
	}
	return nil
}

func inventory() ([]device, error) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	devices := make([]device, 0, len(interfaces))
	for _, iface := range interfaces {
		addresses, err := iface.Addrs()
		if err != nil {
			return nil, err
		}
		d := device{name: iface.Name, index: iface.Index, up: iface.Flags&net.FlagUp != 0}
		for _, address := range addresses {
			ip, _, err := net.ParseCIDR(address.String())
			if err == nil && ip.To4() != nil {
				d.addresses = append(d.addresses, ip.String())
			}
		}
		devices = append(devices, d)
	}
	return devices, nil
}

func validateSelection(s selection, devices []device, eligible func(string) bool) error {
	if err := s.checkShape(); err != nil {
		return err
	}
	if !eligible(s.Name) {
		return errors.New("selected interface is not an eligible VPN tunnel")
	}
	for _, d := range devices {
		if d.index != s.Index {
			continue
		}
		if d.name != s.Name || !d.up {
			return errors.New("selected VPN interface changed or is down")
		}
		for _, address := range d.addresses {
			if address == s.Address {
				return nil
			}
		}
		return errors.New("selected IPv4 source is no longer assigned to VPN interface")
	}
	return errors.New("selected VPN interface disappeared")
}

func (s selection) check() error {
	devices, err := inventory()
	if err != nil {
		return errors.New("unable to inspect VPN interfaces")
	}
	return validateSelection(s, devices, eligibleInterface)
}

func listInterfaces() ([]selection, error) {
	if !supportedPlatform() {
		return nil, errors.New("VPN helper supports only macOS and Windows")
	}
	devices, err := inventory()
	if err != nil {
		return nil, err
	}
	result := make([]selection, 0)
	for _, d := range devices {
		if !d.up || !eligibleInterface(d.name) {
			continue
		}
		for _, address := range d.addresses {
			s := selection{Name: d.name, Index: d.index, Address: address}
			if s.checkShape() == nil {
				result = append(result, s)
			}
		}
	}
	if len(result) > 128 {
		return nil, errors.New("too many VPN interface addresses")
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Index == result[j].Index {
			return result[i].Address < result[j].Address
		}
		return result[i].Index < result[j].Index
	})
	return result, nil
}

func parseIndex(value string) (int, error) {
	index, err := strconv.ParseInt(value, 10, 32)
	if err != nil || index < 1 || index > 0xffffff {
		return 0, fmt.Errorf("invalid interface index")
	}
	return int(index), nil
}
