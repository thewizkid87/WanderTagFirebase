#!/usr/bin/env bash
set -euo pipefail

PI_USER="${PI_USER:-piuser}"
APP_DIR="${APP_DIR:-/home/${PI_USER}/printer_service}"
VENV_DIR="${APP_DIR}/venv"
SERVICE_NAME="printer_firmware"
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

echo "[1/7] Installing OS dependencies..."
apt-get update -y
apt-get install -y python3 python3-venv python3-full ca-certificates curl

echo "[2/7] Creating app directory ${APP_DIR}..."
mkdir -p "${APP_DIR}"
chown -R "${PI_USER}:${PI_USER}" "${APP_DIR}"

echo "[3/7] Copying firmware files..."
install -o "${PI_USER}" -g "${PI_USER}" -m 0755 "${SOURCE_DIR}/firmware.py" "${APP_DIR}/firmware.py"
install -o "${PI_USER}" -g "${PI_USER}" -m 0644 "${SOURCE_DIR}/requirements.txt" "${APP_DIR}/requirements.txt"
install -o "${PI_USER}" -g "${PI_USER}" -m 0644 "${SOURCE_DIR}/config.example.json" "${APP_DIR}/config.example.json"

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
  "firmwareVersion": 1,
  "ignoreHs": false
}
EOF
  chown "${PI_USER}:${PI_USER}" "${APP_DIR}/config.json"
fi

echo "[4/7] Creating Python venv and installing dependencies..."
sudo -u "${PI_USER}" python3 -m venv "${VENV_DIR}"
sudo -u "${PI_USER}" "${VENV_DIR}/bin/python" -m pip install --upgrade pip >/dev/null
sudo -u "${PI_USER}" "${VENV_DIR}/bin/pip" install -r "${APP_DIR}/requirements.txt"

echo "[5/7] Writing systemd service..."
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
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

echo "[6/7] Enabling service..."
systemctl enable "${SERVICE_NAME}.service"

echo "[7/7] Starting service..."
systemctl restart "${SERVICE_NAME}.service"

echo ""
echo "Installed printer firmware service: ${SERVICE_NAME}.service"
echo "Config file: ${APP_DIR}/config.json"
echo "Logs: journalctl -u ${SERVICE_NAME}.service -f"
echo ""
echo "For simulator mode, pass --sim when installing or set printerTransport=sim in config.json."
