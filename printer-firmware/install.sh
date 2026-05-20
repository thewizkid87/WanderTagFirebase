#!/usr/bin/env bash
set -euo pipefail

PI_USER="${PI_USER:-piuser}"
APP_DIR="${APP_DIR:-/home/${PI_USER}/printer_service}"
VENV_DIR="${APP_DIR}/venv"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="${SCRIPT_DIR}"
FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-wandertag-fb685}"
DEFAULT_DATABASE_URL="${DATABASE_URL:-https://${FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com}"
DEFAULT_PRINTER_HOST="${PRINTER_HOST:-192.168.2.2}"
DEFAULT_PRINTER_PORT="${PRINTER_PORT:-9100}"
DEFAULT_LOCAL_IP="${LOCAL_IP:-192.168.2.20}"
SERVICE_ACCOUNT_PATH="${SERVICE_ACCOUNT_PATH:-${APP_DIR}/service-account.json}"
MODE="real"
DATABASE_EMULATOR_HOST_JSON="null"

WATCHDOG_SERVICE_NAME="printer_watchdog"
FIRMWARE_SERVICE_NAME="printer_firmware"
LEGACY_SERVICE_NAMES=("print_service" "printer_firmware" "printer_watchdog")

usage() {
  cat <<EOF
Usage: sudo bash install.sh [--sim|--real]

Environment overrides:
  PI_USER, APP_DIR, FIREBASE_PROJECT_ID, DATABASE_URL, PRINTER_HOST, PRINTER_PORT, LOCAL_IP, SERVICE_ACCOUNT_PATH
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sim)
      MODE="sim"
      shift
      ;;
    --real)
      MODE="real"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ "${MODE}" == "sim" ]]; then
  DATABASE_EMULATOR_HOST_JSON="\"127.0.0.1:9000\""
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root: sudo bash install.sh"
  exit 1
fi

echo "[1/8] Installing OS dependencies..."
apt-get update -y
apt-get install -y python3 python3-venv python3-full ca-certificates curl

echo "[2/8] Removing old services if they exist..."
for service_name in "${LEGACY_SERVICE_NAMES[@]}"; do
  systemctl stop "${service_name}.service" >/dev/null 2>&1 || true
  systemctl disable "${service_name}.service" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/${service_name}.service" || true
done
systemctl daemon-reload || true

echo "[3/8] Creating app directory ${APP_DIR}..."
mkdir -p "${APP_DIR}"
chown -R "${PI_USER}:${PI_USER}" "${APP_DIR}"

echo "[4/8] Copying firmware files..."
copy_if_needed() {
  local src="$1"
  local dst="$2"
  local mode="$3"
  if [[ -f "${dst}" ]] && cmp -s "${src}" "${dst}"; then
    return 0
  fi
  install -o "${PI_USER}" -g "${PI_USER}" -m "${mode}" "${src}" "${dst}"
}

copy_if_needed "${SOURCE_DIR}/firmware.py" "${APP_DIR}/firmware.py" 0755
copy_if_needed "${SOURCE_DIR}/watchdog.py" "${APP_DIR}/watchdog.py" 0755
copy_if_needed "${SOURCE_DIR}/requirements.txt" "${APP_DIR}/requirements.txt" 0644
copy_if_needed "${SOURCE_DIR}/config.example.json" "${APP_DIR}/config.example.json" 0644

if [[ ! -f "${APP_DIR}/config.json" ]]; then
  cat > "${APP_DIR}/config.json" <<EOF
{
  "printerId": null,
  "printerTransport": "${MODE}",
  "printerHost": "${DEFAULT_PRINTER_HOST}",
  "printerPort": ${DEFAULT_PRINTER_PORT},
  "localIp": "${DEFAULT_LOCAL_IP}",
  "databaseURL": "${DEFAULT_DATABASE_URL}",
  "databaseEmulatorHost": ${DATABASE_EMULATOR_HOST_JSON},
  "serviceAccountPath": "${SERVICE_ACCOUNT_PATH}",
  "firmwareVersion": "",
  "prevFirmwareVersion": null,
  "ignoredFirmwareVersions": [],
  "ignoreHs": false
}
EOF
  chown "${PI_USER}:${PI_USER}" "${APP_DIR}/config.json"
fi

echo "[5/8] Creating Python venv and installing dependencies..."
sudo -u "${PI_USER}" python3 -m venv "${VENV_DIR}"
sudo -u "${PI_USER}" "${VENV_DIR}/bin/python" -m pip install --upgrade pip >/dev/null
sudo -u "${PI_USER}" "${VENV_DIR}/bin/pip" install -r "${APP_DIR}/requirements.txt"

echo "[6/8] Installing systemd services..."
cat > "/etc/systemd/system/${WATCHDOG_SERVICE_NAME}.service" <<EOF
[Unit]
Description=WanderTag Printer Watchdog
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
ExecStart=${VENV_DIR}/bin/python ${APP_DIR}/watchdog.py
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF

cat > "/etc/systemd/system/${FIRMWARE_SERVICE_NAME}.service" <<EOF
[Unit]
Description=WanderTag Printer Firmware
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${PI_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${VENV_DIR}/bin/python ${APP_DIR}/firmware.py
Restart=always
RestartSec=2
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload

echo "[7/8] Enabling and starting services..."
systemctl enable "${FIRMWARE_SERVICE_NAME}.service"
systemctl enable "${WATCHDOG_SERVICE_NAME}.service"
systemctl restart "${FIRMWARE_SERVICE_NAME}.service"
systemctl restart "${WATCHDOG_SERVICE_NAME}.service"

echo "[8/8] Running watchdog once..."
sudo -u root "${VENV_DIR}/bin/python" "${APP_DIR}/watchdog.py" --once || true

echo ""
echo "✅ Installed."
echo ""
echo "Services:"
echo "  sudo systemctl status ${FIRMWARE_SERVICE_NAME}.service"
echo "  sudo systemctl status ${WATCHDOG_SERVICE_NAME}.service"
echo "  sudo systemctl stop ${FIRMWARE_SERVICE_NAME}.service"
echo "  sudo systemctl stop ${WATCHDOG_SERVICE_NAME}.service"
echo "  sudo systemctl restart ${FIRMWARE_SERVICE_NAME}.service"
echo "  sudo systemctl restart ${WATCHDOG_SERVICE_NAME}.service"
echo ""
echo "Logs:"
echo "  sudo journalctl -u ${FIRMWARE_SERVICE_NAME}.service -f"
echo "  sudo journalctl -u ${WATCHDOG_SERVICE_NAME}.service -f"
echo ""
echo "Config:"
echo "  ${APP_DIR}/config.json"
echo ""
echo "For simulator mode, pass --sim when installing or set printerTransport=sim in config.json."
