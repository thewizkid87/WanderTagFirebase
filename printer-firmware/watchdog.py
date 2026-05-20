#!/usr/bin/env python3
import json
import logging
import os
import shutil
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional

import firebase_admin
from firebase_admin import credentials, db

UPDATE_INTERVAL_SECONDS = 60
ROLLBACK_GRACE_SECONDS = 20

APP_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(APP_DIR, "config.json")
FIRMWARE_PATH = os.path.join(APP_DIR, "firmware.py")
FIRMWARE_OLD_PATH = os.path.join(APP_DIR, "firmware.old")
SERVICE_NAME = "printer_firmware"


def setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )


def load_config() -> Dict[str, Any]:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    cfg.setdefault("firmwareVersion", "")
    cfg.setdefault("prevFirmwareVersion", None)
    cfg.setdefault("ignoredFirmwareVersions", [])
    return cfg


def save_config(cfg: Dict[str, Any]) -> None:
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
      json.dump(cfg, f, indent=2)
    os.replace(tmp, CONFIG_PATH)


def init_firebase(cfg: Dict[str, Any]) -> None:
    if firebase_admin._apps:
        return

    options = {}
    if cfg.get("databaseURL"):
        options["databaseURL"] = cfg["databaseURL"]

    emulator_host = cfg.get("databaseEmulatorHost")
    if emulator_host:
        os.environ["FIREBASE_DATABASE_EMULATOR_HOST"] = str(emulator_host)

    service_account_path = cfg.get("serviceAccountPath")
    if service_account_path:
        cred = credentials.Certificate(service_account_path)
        firebase_admin.initialize_app(cred, options)
    else:
        firebase_admin.initialize_app(options=options)


def ref(path: str):
    return db.reference(path)


def run_systemctl(*args: str) -> int:
    cmd = ["/bin/systemctl", *args]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        logging.error("systemctl %s failed rc=%s stderr=%s", " ".join(args), proc.returncode, (proc.stderr or "")[:500])
    return proc.returncode


def is_service_active(service_name: str) -> bool:
    proc = subprocess.run(["/bin/systemctl", "is-active", f"{service_name}.service"], capture_output=True, text=True)
    return proc.returncode == 0 and (proc.stdout or "").strip() == "active"


def load_latest_firmware() -> Optional[Dict[str, Any]]:
    snap = ref("firmware/latest").get()
    if not snap:
        return None
    return snap


def write_firmware(body: str) -> bool:
    try:
        with open(FIRMWARE_PATH + ".tmp", "w", encoding="utf-8") as f:
            f.write(body)
        os.replace(FIRMWARE_PATH + ".tmp", FIRMWARE_PATH)
        os.chmod(FIRMWARE_PATH, 0o755)
        return True
    except Exception as exc:
        logging.error("Failed writing new firmware.py: %s", exc)
        return False


def backup_current_firmware() -> None:
    if os.path.exists(FIRMWARE_OLD_PATH):
        os.remove(FIRMWARE_OLD_PATH)
    if os.path.exists(FIRMWARE_PATH):
        shutil.copy2(FIRMWARE_PATH, FIRMWARE_OLD_PATH)
        logging.info("Backed up firmware.py -> firmware.old")


def rollback(cfg: Dict[str, Any], bad_version: int) -> None:
    ignored: List[int] = list(cfg.get("ignoredFirmwareVersions") or [])
    if bad_version not in ignored:
        ignored.append(bad_version)
    cfg["ignoredFirmwareVersions"] = ignored

    if os.path.exists(FIRMWARE_OLD_PATH):
        shutil.copy2(FIRMWARE_OLD_PATH, FIRMWARE_PATH)
        os.chmod(FIRMWARE_PATH, 0o755)
        logging.info("Rollback: restored firmware.old -> firmware.py")

    prev_ver = cfg.get("prevFirmwareVersion")
    if prev_ver is not None:
        cfg["firmwareVersion"] = int(prev_ver)
    save_config(cfg)

    run_systemctl("restart", SERVICE_NAME)
    logging.error("Rollback complete. Ignored bad firmwareVersion=%s", bad_version)


def apply_update(cfg: Dict[str, Any]) -> bool:
    latest = load_latest_firmware()
    if not latest:
        return False

    latest_version = int(latest.get("version") or 0)
    latest_checksum = latest.get("checksum")
    latest_body = latest.get("body")
    current_version = str(cfg.get("firmwareVersion") or "")
    ignored = set(str(v) for v in (cfg.get("ignoredFirmwareVersions") or []))

    if latest_version == current_version:
        return False

    if latest_version in ignored:
        logging.warning("Skipping ignored firmwareVersion=%s", latest_version)
        return False

    if not isinstance(latest_body, str) or not latest_body.strip():
        logging.error("Latest firmware payload is empty; refusing to overwrite.")
        return False

    logging.info("Firmware update available version=%s checksum=%s", latest_version, latest_checksum)
    run_systemctl("stop", SERVICE_NAME)
    backup_current_firmware()

    cfg["prevFirmwareVersion"] = current_version
    save_config(cfg)

    if not write_firmware(latest_body):
        if os.path.exists(FIRMWARE_OLD_PATH):
            shutil.copy2(FIRMWARE_OLD_PATH, FIRMWARE_PATH)
            os.chmod(FIRMWARE_PATH, 0o755)
        run_systemctl("restart", SERVICE_NAME)
        return False

    cfg["firmwareVersion"] = latest_version
    save_config(cfg)

    run_systemctl("daemon-reload")
    run_systemctl("restart", SERVICE_NAME)

    time.sleep(ROLLBACK_GRACE_SECONDS)
    if not is_service_active(SERVICE_NAME):
        logging.error("New firmware failed to stay active after %ss", ROLLBACK_GRACE_SECONDS)
        rollback(cfg, latest_version)
        return False

    logging.info("Firmware update applied successfully; %s is active (version=%s).", SERVICE_NAME, latest_version)
    return True


def ensure_firmware_exists(cfg: Dict[str, Any]) -> None:
    if not os.path.exists(FIRMWARE_PATH):
        logging.info("firmware.py missing; trying update fetch")
        apply_update(cfg)


def run_once() -> None:
    cfg = load_config()
    init_firebase(cfg)
    ensure_firmware_exists(cfg)
    apply_update(cfg)


def main_loop() -> None:
    cfg = load_config()
    init_firebase(cfg)
    ensure_firmware_exists(cfg)
    apply_update(cfg)

    while True:
        try:
            cfg = load_config()
            apply_update(cfg)
        except Exception as exc:
            logging.exception("Watchdog loop error: %s", exc)
        time.sleep(UPDATE_INTERVAL_SECONDS)


if __name__ == "__main__":
    setup_logging()
    if "--once" in sys.argv:
        logging.info("Running watchdog once...")
        run_once()
        sys.exit(0)

    logging.info("Starting watchdog main loop...")
    main_loop()
