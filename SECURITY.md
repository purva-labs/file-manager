# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting. Do not publish vulnerability details in an issue.

## Deployment boundary

Standalone File Manager can read, modify, and delete everything below `FILEMANAGER_ROOT`. It has no built-in user authentication. Bind it to localhost and add authentication at a trusted reverse proxy before network exposure.

Distributed agent mode requires a bearer token and is designed to bind to a private Tailscale address. When configured with the host root read/write, the agent is intentionally root-equivalent: anyone who can reach the hub UI can read, change, or delete host files. Never publish the hub or agent port through a public reverse proxy, never commit node tokens, use a different random token per node, and restrict the token files to root.
