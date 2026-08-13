# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting. Do not publish vulnerability details in an issue.

## Deployment boundary

Standalone File Manager can read, modify, and delete everything below `FILEMANAGER_ROOT`. It has no built-in user authentication. Bind it to localhost and add authentication at a trusted reverse proxy before network exposure.

Distributed agent mode requires a bearer token and is designed to bind to a specific address on a private overlay network such as Tailscale or WireGuard. When configured with the host root read/write, the agent is intentionally root-equivalent: anyone who can reach the hub UI can read, change, or delete host files.

The hub UI has no built-in user authentication. Network access controls are the user-facing authorization boundary. Never bind a distributed service to a wildcard or public address, publish the hub or agent port through a public reverse proxy, commit node tokens, or reuse one token across nodes. Restrict deployment configuration and tokens to root with mode `0600`.

The hub sends agent requests to administrator-configured URLs. Treat write access to `nodes.json` and the token directory as equivalent to control of the deployment.

## Agent enrollment

The hub can generate a random single-use enrollment code that expires after 15 minutes. The code authorizes one node registration and is removed before the hub verifies or stores the agent. A successful registration creates a separate permanent credential for that node; the permanent credential is not included in the generated shell command.

Creating enrollment codes is protected by the same private-network boundary as the rest of the hub UI. Do not expose the enrollment endpoints publicly, paste generated commands into shared logs, or use an unencrypted network between the hub and agent. Generate a new code if installation fails; codes cannot be reused.
