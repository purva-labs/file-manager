#!/usr/bin/env bash
set -euo pipefail

install_dir=/opt/file-manager-agent
config_dir=/etc/file-manager-agent
listen_host=
port=3091
managed_root=/
display_root=/

usage() {
  cat <<'EOF'
Usage: sudo ./deploy/install-agent.sh --listen-host ADDRESS [options]

Installs a root-level File Manager agent as a systemd service.

Options:
  --listen-host ADDRESS  Private-network address to bind (required)
  --port PORT            Agent port (default: 3091)
  --root PATH            Filesystem subtree to expose (default: /)
  --display-root PATH    Path shown in the UI (default: /)
  -h, --help             Show this help

The installer generates /etc/file-manager-agent/token if it does not exist.
It never prints the token.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --listen-host) listen_host=${2:-}; shift 2 ;;
    --port) port=${2:-}; shift 2 ;;
    --root) managed_root=${2:-}; shift 2 ;;
    --display-root) display_root=${2:-}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ${EUID} -ne 0 ]]; then
  echo 'Run this installer with sudo or as root.' >&2
  exit 1
fi
if [[ -z ${listen_host} || ${listen_host} == 0.0.0.0 || ${listen_host} == :: ]]; then
  echo '--listen-host must be a specific private-network address, not a wildcard.' >&2
  exit 2
fi
if ! node -e 'process.exit(require("node:net").isIP(process.argv[1]) ? 0 : 1)' "${listen_host}"; then
  echo '--listen-host must be an IPv4 or IPv6 address assigned to this node.' >&2
  exit 2
fi
if [[ ! ${port} =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  echo '--port must be between 1 and 65535.' >&2
  exit 2
fi
if [[ ${managed_root} != /* || ${display_root} != /* ]]; then
  echo '--root and --display-root must be absolute paths.' >&2
  exit 2
fi
if [[ ! -d ${managed_root} ]]; then
  echo "Managed root does not exist: ${managed_root}" >&2
  exit 2
fi
for command in node npm openssl systemctl; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Missing required command: ${command}" >&2
    exit 1
  fi
done

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
stage_dir=$(mktemp -d "${install_dir}.new.XXXXXX")
cleanup() {
  if [[ -d ${stage_dir} ]]; then
    find "${stage_dir}" -depth -delete
  fi
}
trap cleanup EXIT

install -d -m 0755 "${stage_dir}/src" "${stage_dir}/public"
install -m 0644 "${source_dir}/package.json" "${source_dir}/package-lock.json" "${stage_dir}/"
find "${source_dir}/src" -maxdepth 1 -type f -exec install -m 0644 -t "${stage_dir}/src" {} +
find "${source_dir}/public" -maxdepth 1 -type f -exec install -m 0644 -t "${stage_dir}/public" {} +
npm ci --omit=dev --prefix "${stage_dir}"

install -d -o root -g root -m 0700 "${config_dir}"
if [[ ! -s ${config_dir}/token ]]; then
  umask 077
  openssl rand -hex 32 > "${config_dir}/token"
fi
chown root:root "${config_dir}/token"
chmod 0600 "${config_dir}/token"

env_tmp=$(mktemp)
printf 'PORT=%s\nFILEMANAGER_LISTEN_HOST=%s\nFILEMANAGER_ROOT=%s\nFILEMANAGER_DISPLAY_ROOT=%s\n' \
  "${port}" "${listen_host}" "${managed_root}" "${display_root}" > "${env_tmp}"
install -o root -g root -m 0600 "${env_tmp}" "${config_dir}/agent.env"
rm -f "${env_tmp}"

systemctl stop file-manager-agent.service 2>/dev/null || true
if [[ -d ${install_dir} ]]; then
  previous_dir=${install_dir}.previous
  if [[ -d ${previous_dir} ]]; then
    find "${previous_dir}" -depth -delete
  fi
  mv "${install_dir}" "${previous_dir}"
fi
mv "${stage_dir}" "${install_dir}"
stage_dir=
chown -R root:root "${install_dir}"
install -o root -g root -m 0644 "${source_dir}/deploy/file-manager-agent.service" /etc/systemd/system/file-manager-agent.service
systemctl daemon-reload
systemctl enable --now file-manager-agent.service

echo "File Manager agent is active on ${listen_host}:${port}."
echo "Token file: ${config_dir}/token (root-only; value not displayed)"
