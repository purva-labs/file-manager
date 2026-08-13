# Contributing

Contributions are welcome. Fork the repository, create a focused branch, and keep deployment-specific addresses, hostnames, mount paths, and credentials out of commits.

Before opening a pull request:

1. Add or update tests for path-safety, authentication, proxy, or file-operation changes.
2. Run `npm test` and `npm audit --audit-level=high` on Node.js 18 or newer.
3. Run `bash -n deploy/*.sh deploy/homeassistant-addon/run.sh` when changing shell scripts.
4. Run `./deploy/package-homeassistant-addon.sh` and build the generated directory when changing the Home Assistant package.
5. Perform a browser check for UI changes.
6. Update the examples and README when changing environment variables or deployment behavior.

Security fixes should be reported privately as described in [SECURITY.md](SECURITY.md).
