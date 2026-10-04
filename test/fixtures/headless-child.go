// Inert packaged-launch fixture. No API calls, credentials, or production use.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
)

func main() {
	args := os.Args[1:]
	if len(args) < 2 || args[0] != "--settings" {
		fmt.Fprintln(os.Stderr, "fixture requires owned inline settings")
		os.Exit(91)
	}
	var settings struct {
		Env map[string]string `json:"env"`
	}
	if json.Unmarshal([]byte(args[1]), &settings) != nil {
		fmt.Fprintln(os.Stderr, "fixture settings malformed")
		os.Exit(92)
	}
	input, err := io.ReadAll(io.LimitReader(os.Stdin, 1024*1024))
	if err != nil {
		os.Exit(93)
	}
	env := make(map[string]string)
	for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "TZ", "LANG", "LC_ALL", "DISABLE_ERROR_REPORTING", "CLAUDE_CODE_PROXY_RESOLVES_HOSTS"} {
		env[key] = os.Getenv(key)
	}
	result := map[string]interface{}{"input": string(input), "args": args[2:], "env": env, "settingsEnv": settings.Env}
	encoded, err := json.Marshal(result)
	if err != nil {
		os.Exit(94)
	}
	fmt.Fprint(os.Stdout, string(encoded))
	fmt.Fprint(os.Stderr, "fixture stderr without final newline")
	os.Exit(7)
}
