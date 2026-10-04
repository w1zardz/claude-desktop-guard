# Public packaged-smoke TLS fixture

The certificate and private key in this folder are public test data. Never use
them for a real service, identity, or deployment.

The offline smoke test binds only IPv4 loopback. Its proxy accepts only the
`api.ipify.org:443` and `ipinfo.io:443` CONNECT names and sends both to the local
HTTPS fixture. No connection to those real services is made. Synthetic exit
responses are test inputs, not measurements of the machine's location.

`NODE_EXTRA_CA_CERTS` trusts this certificate only in the spawned test process;
TLS verification and hostname checks remain enabled. System trust is unchanged.
