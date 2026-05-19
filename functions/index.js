"use strict";

const functions = require("firebase-functions");
const compiled = require("./lib/index.js");

Object.assign(exports, compiled);

exports.health = functions.https.onRequest((req, res) => {
  res.status(200).send("OK");
});
