# Security

The local gate has no direct destination path. It connects only to the explicitly selected loopback upstream proxy and tunnels TLS without intercepting it. The GUI renderer has no Node access, no remote content, no navigation, no permissions and a restrictive CSP. Controller secrets are transient; saved profiles omit them. Configuration backups remain in the user's application-data folder.

The gate is not a system firewall. Other local programs, privileged services, the system browser, proxy split routes and remote Code sessions need independent enforcement. Country data comes from ipinfo; two independent IP observations do not amount to independent geographic confirmation. Do not infer account-safety guarantees from a successful check.

Sensitive settings may exist in the transaction journal because restoring them requires keeping their original values. The application uses private file modes on POSIX; Windows additionally relies on the user's profile-directory ACLs. Avoid sharing this journal, screenshots of personal exit addresses, or controller secrets in a public issue.

Use GitHub's private vulnerability reporting for security findings if available. Public issues should include only a minimal sanitized reproduction. Never attach account tokens or a real configuration backup.
