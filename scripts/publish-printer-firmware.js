#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const admin = require("../functions/node_modules/firebase-admin");

const projectId = process.env.FIREBASE_PROJECT_ID || "wandertag-fb685";
const databaseURL = process.env.FIREBASE_DATABASE_URL || `https://${projectId}-default-rtdb.firebaseio.com`;
const firmwarePath = process.env.FIRMWARE_PATH || path.resolve(__dirname, "../printer-firmware/firmware.py");
if (!admin.apps.length) {
  admin.initializeApp({
    projectId,
    databaseURL,
  });
}

const body = fs.readFileSync(firmwarePath, "utf8");
const checksum = crypto.createHash("sha256").update(body).digest("hex");

async function main() {
  const version = crypto.createHash("sha256").update(body).digest("hex");
  await admin.database().ref("firmware/latest").set({
    version,
    body,
    updatedAt: Date.now(),
    sourcePath: path.basename(firmwarePath),
  });

  console.log(
    JSON.stringify(
      {
        projectId,
        databaseURL,
        firmwarePath,
        version,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
