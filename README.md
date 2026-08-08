# File Manager

A lightweight, self-hosted web file manager. Choose one host directory and the app exposes everything beneath it through a responsive browser interface.

## Features

- Browse every file and folder beneath the configured root
- Upload, preview, download, copy, rename, and delete entries
- Create folders and inspect directory sizes
- Multi-select files with keyboard modifiers
- Back navigation, clickable breadcrumbs, folder search, and drag-and-drop uploads
- Blocks path traversal and symbolic-link escapes outside the configured root

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

## Development

```bash
npm ci
FILEMANAGER_ROOT="$PWD/data" npm start
npm test
```

## License

MIT. See [LICENSE](LICENSE).
