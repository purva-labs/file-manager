# File Manager

A lightweight, self-hosted web file manager. Choose one host directory and the app exposes everything beneath it through a responsive browser interface.

It can also run as a distributed hub with a small authenticated agent on every node. The hub keeps agent credentials server-side and gives the browser one node selector.

## Features

- Browse every file and folder beneath the configured root
- Upload, preview, download, copy, rename, and delete entries
- Create folders and inspect directory sizes
- Multi-select files with keyboard modifiers
- Back navigation, clickable breadcrumbs, folder search, and drag-and-drop uploads
- Blocks path traversal and symbolic-link escapes outside the configured root
- Select and browse multiple nodes through one hub UI
- Stream uploads and downloads through the hub without exposing agent credentials
- Bind both hub and agents to a Tailscale address only
- Discover mounted persistent filesystems so system disks, attached disks, and network mounts are visible separately

## Quick start

```bash
cp .env.example .env
# Edit FILEMANAGER_ROOT to the host folder you want to expose.
docker compose up -d --build
```

Open <http://localhost:3088>.

## Configuration

The application has one configurable environment variable:

```dotenv
FILEMANAGER_ROOT=/absolute/host/path
```

Compose mounts that host folder at `/data` inside the container. The application cannot browse outside that mount.

## Security

File Manager can modify and permanently delete files. It intentionally binds to `127.0.0.1` by default and does not include authentication. Keep it private, or place it behind an authenticated reverse proxy before exposing it to a network.

Use a dedicated directory and give the container only the permissions it needs. Do not mount `/`, your Docker socket, SSH configuration, or secret directories.

### Distributed root mode

Root mode is intentionally different: the agent bind-mounts the host root read/write and therefore has root-equivalent file access. Only use it when that is the explicit goal.

The supplied distributed Compose files use host networking but make the processes listen on `TAILSCALE_IP`, not on LAN or wildcard addresses. Every agent request also requires a long random bearer token read from a root-only file. The hub reads those token files and never returns tokens or agent URLs to the browser.

Create separate random tokens for every node, store them with mode `0600`, and keep the hub and agent ports out of public reverse proxies. Tailscale access controls remain the user-facing authorization boundary.

## Distributed deployment

The hub machine runs both `deploy/compose-hub-and-agent.yml` and its own agent. Other machines run `deploy/compose-agent.yml`.

For a lightweight Ubuntu node without Docker, install the application under `/opt/file-manager-agent`, place its environment and token under `/etc/file-manager-agent`, and use `deploy/file-manager-agent.service`. A supported Home Assistant local-app package is provided under `deploy/homeassistant-addon`; HAOS exposes its persistent configuration, app data, backups, media, share, and SSL areas rather than its immutable operating-system image.

For the hub host, create a private `nodes.json` from `deploy/nodes.example.json`. Each `url` should be the node's current Tailscale IPv4 address and agent port. Each `tokenFile` is the path as seen inside the hub container under `/run/file-manager/secrets`.

Required Compose variables for the hub host:

```dotenv
TAILSCALE_IP=100.x.y.z
HUB_PORT=3090
AGENT_PORT=3091
NODES_FILE=/absolute/private/path/nodes.json
SECRETS_DIR=/absolute/private/path/secrets
AGENT_TOKEN_FILE=/absolute/private/path/secrets/this-node.token
```

Required variables for an agent-only host:

```dotenv
TAILSCALE_IP=100.x.y.z
AGENT_PORT=3091
AGENT_TOKEN_FILE=/absolute/private/path/agent.token
```

Then start the appropriate file from the `deploy` directory:

```bash
docker compose --env-file /absolute/private/path/deployment.env \
  -f compose-hub-and-agent.yml up -d --build
```

Open `http://<hub-tailscale-ip>:3090`. A standalone deployment using the root-level `docker-compose.yml` continues to work as before.

## Development

```bash
npm ci
FILEMANAGER_ROOT="$PWD/data" npm start
npm test
```

## License

MIT. See [LICENSE](LICENSE).
