package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"time"
)

func run(arguments []string, input io.Reader, output io.Writer) error {
	if !supportedPlatform() {
		return errors.New("VPN helper supports only macOS and Windows; Linux is unsupported")
	}
	flags := flag.NewFlagSet("vpn-helper", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	list := flags.Bool("list", false, "list eligible tunnel interfaces")
	name := flags.String("interface", "", "selected interface name")
	indexValue := flags.String("index", "", "selected interface index")
	address := flags.String("address", "", "selected IPv4 source")
	if flags.Parse(arguments) != nil || len(flags.Args()) != 0 {
		return errors.New("invalid helper arguments")
	}
	if *list {
		if *name != "" || *indexValue != "" || *address != "" {
			return errors.New("--list cannot be combined with a selected interface")
		}
		interfaces, err := listInterfaces()
		if err != nil {
			return err
		}
		return json.NewEncoder(output).Encode(interfaces)
	}
	index, err := parseIndex(*indexValue)
	if err != nil {
		return err
	}
	selected := selection{Name: *name, Index: index, Address: *address}
	if err := selected.check(); err != nil {
		return err
	}
	g := newGateway(selected)
	defer g.terminate(nil)
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return errors.New("unable to listen on localhost")
	}
	defer listener.Close()
	server := &http.Server{Handler: g, MaxHeaderBytes: 16 * 1024, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 5 * time.Second, WriteTimeout: 10 * time.Second, ErrorLog: log.New(io.Discard, "", 0)}
	served := make(chan error, 1)
	go func() { served <- server.Serve(&trackedListener{Listener: listener, owner: g}) }()
	if err := json.NewEncoder(output).Encode(struct {
		ProxyURL  string    `json:"proxyUrl"`
		Interface selection `json:"interface"`
	}{ProxyURL: "http://" + listener.Addr().String(), Interface: selected}); err != nil {
		return errors.New("unable to report helper readiness")
	}
	go g.watchdog()
	go func() { io.Copy(io.Discard, input); g.terminate(nil) }()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt)
	defer signal.Stop(signals)
	select {
	case reason := <-g.fatal:
		return reason
	case <-g.ctx.Done():
		select {
		case reason := <-g.fatal:
			return reason
		default:
			return nil
		}
	case <-signals:
		return nil
	case <-served:
		return errors.New("local VPN proxy stopped")
	}
}

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}
