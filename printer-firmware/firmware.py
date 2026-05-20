#!/usr/bin/env python3
import base64
import hashlib
import hmac
import json
import logging
import os
import socket
import sys
import time
from typing import Any, Dict, List, Optional

import firebase_admin
from firebase_admin import credentials, db

POLL_INTERVAL_SECONDS = 1
HEARTBEAT_INTERVAL_SECONDS = 5
SHORT_ID_EPOCH = time.mktime(time.strptime("2020-01-01", "%Y-%m-%d"))
DEFAULT_SIMULATOR_HS = "0,0,0\r\n0,0,0,0\r\n"

APP_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(APP_DIR, "config.json")


class PrinterDeviceStatus:
    OK = "OK"
    OUT_OF_PAPER = "OUT_OF_PAPER"
    HEAD_OPEN = "HEAD_OPEN"
    PAUSED = "PAUSED"
    RIBBON_OUT = "RIBBON_OUT"
    ERROR_NO_HS = "ERROR_NO_HS"


def setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )


def load_config() -> Dict[str, Any]:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


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


def base32_decode_nopad(b32: str) -> bytes:
    s = (b32 or "").strip().replace(" ", "").upper()
    s += "=" * ((-len(s)) % 8)
    return base64.b32decode(s, casefold=True)


def generate_totp(secret_b32: str, time_millis: int) -> str:
    period_seconds = 30
    digits = 6
    key = base32_decode_nopad(secret_b32)
    counter = int((time_millis // 1000) // period_seconds)
    msg = counter.to_bytes(8, "big")
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    binary = int.from_bytes(digest[offset:offset + 4], "big") & 0x7fffffff
    return str(binary % (10 ** digits)).zfill(digits)


def parse_hs_status(hs_raw: Optional[str]) -> str:
    if not hs_raw or not hs_raw.strip():
        return PrinterDeviceStatus.ERROR_NO_HS

    cleaned = hs_raw.replace("\x02", "").replace("\x03", "")
    cleaned = cleaned.replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.strip() for line in cleaned.split("\n") if line.strip()]
    if len(lines) < 2:
        return PrinterDeviceStatus.ERROR_NO_HS

    p1 = [p.strip() for p in lines[0].split(",")]
    p2 = [p.strip() for p in lines[1].split(",")]

    def is_one(parts: List[str], idx: int) -> bool:
        try:
            return parts[idx] == "1"
        except Exception:
            return False

    paper_out = is_one(p1, 1)
    paused = is_one(p1, 2)
    head_open = is_one(p2, 2)
    ribbon_out = is_one(p2, 3)

    if head_open:
        return PrinterDeviceStatus.HEAD_OPEN
    if paper_out:
        return PrinterDeviceStatus.OUT_OF_PAPER
    if ribbon_out:
        return PrinterDeviceStatus.RIBBON_OUT
    if paused:
        return PrinterDeviceStatus.PAUSED
    return PrinterDeviceStatus.OK


class PrinterTransport:
    def get_hs(self) -> Optional[str]:
        raise NotImplementedError

    def send_zpl(self, zpl: str) -> None:
        raise NotImplementedError


class RealSocketPrinterTransport(PrinterTransport):
    def __init__(self, host: str, port: int) -> None:
        self.host = host
        self.port = port

    def get_hs(self) -> Optional[str]:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(1.0)
        try:
            sock.connect((self.host, self.port))
            sock.sendall(b"~HS\r\n")
            sock.settimeout(0.25)

            chunks: List[bytes] = []
            total = 0
            buf = b""
            lines: List[str] = []

            while total < 8192 and len(lines) < 3:
                try:
                    chunk = sock.recv(2048)
                except socket.timeout:
                    break
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                buf += chunk
                text = buf.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
                lines = [line.strip() for line in text.split("\n") if line.strip()]

            raw = b"".join(chunks).decode("utf-8", errors="replace")
            raw = raw.replace("\r\n", "\n").replace("\r", "\n").strip()
            return raw or None
        except Exception as exc:
            logging.warning("~HS raw query failed for %s:%s: %s", self.host, self.port, exc)
            return None
        finally:
            try:
                sock.close()
            except Exception:
                pass

    def send_zpl(self, zpl: str) -> None:
        data = zpl.encode("utf-8")
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(10)
        try:
            sock.connect((self.host, self.port))
            sock.sendall(data)
        finally:
            try:
                sock.close()
            except Exception:
                pass


class SimulatorPrinterTransport(PrinterTransport):
    def get_hs(self) -> Optional[str]:
        return DEFAULT_SIMULATOR_HS

    def send_zpl(self, zpl: str) -> None:
        logging.info("SIMULATOR PRINT ZPL:\n%s", zpl.rstrip())


def build_printer_transport(cfg: Dict[str, Any]) -> PrinterTransport:
    mode = str(cfg.get("printerTransport") or cfg.get("transportMode") or "real").strip().lower()
    if mode in {"sim", "simulator", "simulation", "mock"}:
        logging.info("Using simulator printer transport")
        return SimulatorPrinterTransport()

    printer_host = cfg.get("printerHost", "192.168.2.2")
    printer_port = int(cfg.get("printerPort") or 9100)
    logging.info("Using real socket printer transport for %s:%s", printer_host, printer_port)
    return RealSocketPrinterTransport(printer_host, printer_port)


def ref(path: str):
    return db.reference(path)


def heartbeat(printer_id: str, firmware_version: int, local_ip: str, current_job_id: Optional[str], raw_status: Optional[str]) -> None:
    ref(f"printerHealth/{printer_id}").update({
        "online": True,
        "lastSeenAt": int(time.time() * 1000),
        "currentJobId": current_job_id,
        "firmwareVersion": firmware_version,
        "localIp": local_ip,
        "rawPrinterStatus": raw_status,
        "printerDeviceStatus": parse_hs_status(raw_status),
        "lastActiveTime": int(time.time() * 1000),
    })


def claim_next_job(printer_id: str) -> Optional[tuple[str, Dict[str, Any]]]:
    jobs = ref(f"printerQueues/{printer_id}/jobs").get()
    if not jobs:
        return None

    for job_id, job in sorted(jobs.items(), key=lambda item: item[1].get("createdAt", 0)):
        if job.get("status") != "QUEUED":
            continue

        job_ref = ref(f"printerQueues/{printer_id}/jobs/{job_id}")

        def txn(current):
            if not current or current.get("status") != "QUEUED":
                return current
            current["status"] = "CLAIMED"
            current["claimedAt"] = int(time.time() * 1000)
            return current

        claimed = job_ref.transaction(txn)
        if claimed and claimed.get("status") == "CLAIMED":
            return job_id, claimed

    return None


def mark_job_status(printer_id: str, job_id: str, status: str, failed_reason: Optional[str] = None) -> None:
    payload: Dict[str, Any] = {
        "status": status,
    }
    now = int(time.time() * 1000)
    if status == "PRINTING":
        payload["printingAt"] = now
    elif status == "DONE":
        payload["doneAt"] = now
    elif status in {"FAILED", "TIMEOUT", "CANCELLED"}:
        payload["failedAt"] = now
        if failed_reason:
            payload["failedReason"] = failed_reason

    ref(f"printerQueues/{printer_id}/jobs/{job_id}").update(payload)


def main() -> None:
    setup_logging()
    cfg = load_config()
    init_firebase(cfg)
    transport = build_printer_transport(cfg)

    printer_id = cfg["printerId"]
    local_ip = cfg.get("localIp", "")
    current_job_id: Optional[str] = None
    printer_status_raw: Optional[str] = transport.get_hs()
    last_heartbeat = 0

    while True:
        try:
            if printer_status_raw is None:
                printer_status_raw = transport.get_hs()

            if int(time.time()) - last_heartbeat >= HEARTBEAT_INTERVAL_SECONDS:
                heartbeat(printer_id, int(cfg.get("firmwareVersion") or 0), local_ip, current_job_id, printer_status_raw)
                last_heartbeat = int(time.time())

            claim = claim_next_job(printer_id)
            if not claim:
                time.sleep(POLL_INTERVAL_SECONDS)
                continue

            job_id, job = claim
            current_job_id = job_id
            zpl_body = job.get("zpl")
            if not isinstance(zpl_body, str) or not zpl_body.strip():
                mark_job_status(printer_id, job_id, "FAILED", "Missing zpl")
                current_job_id = None
                time.sleep(POLL_INTERVAL_SECONDS)
                continue

            ignore_hs = bool(cfg.get("ignoreHs", False))
            if not ignore_hs:
                printer_status_raw = transport.get_hs()
                if parse_hs_status(printer_status_raw) != PrinterDeviceStatus.OK:
                    mark_job_status(printer_id, job_id, "FAILED", f"PRE_HS_FAILED status={parse_hs_status(printer_status_raw)}")
                    current_job_id = None
                    time.sleep(POLL_INTERVAL_SECONDS)
                    continue

            mark_job_status(printer_id, job_id, "PRINTING")
            try:
                transport.send_zpl(zpl_body)
                mark_job_status(printer_id, job_id, "DONE")
            except Exception as exc:
                logging.exception("Print failed for job=%s: %s", job_id, exc)
                mark_job_status(printer_id, job_id, "FAILED", str(exc))
            finally:
                current_job_id = None

        except Exception as exc:
            logging.exception("Main loop error: %s", exc)

        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
