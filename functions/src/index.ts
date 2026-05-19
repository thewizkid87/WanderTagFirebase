import express, { Request, Response } from "express";
import cors from "cors";
import admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError, onRequest } from "firebase-functions/v2/https";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onValueWritten } from "firebase-functions/v2/database";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import {
  ageFromBirthYear,
  AuthRequestBody,
  compileTemplate,
  daysSinceShortIdEpoch,
  EventRecord,
  FirmwareRecord,
  KidRecord,
  normalizePhone,
  parseShortCode,
  nowMs,
  PrinterDeviceStatus,
  PrinterHealthRecord,
  PrinterQueueJob,
  PrinterRecord,
  PrinterRegisterBody,
  PrintStatus,
  PrintJobStatus,
  randomToken,
  ScanRecord,
  SessionRecord,
  SessionSnapshot,
  sha256,
  TagCreateBody,
  TagRecord,
  toShortCode,
  UserRecord,
  initials,
  VerifyRequestBody,
} from "./shared";

const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? "wandertag-dev";
const twilioApiKeySid = defineSecret("TWILIO_API_KEY_SID");
const twilioApiKeySecret = defineSecret("TWILIO_API_KEY_SECRET");
const twilioVerifyServiceSid = defineSecret("TWILIO_VERIFY_SERVICE_SID");

admin.initializeApp({
  projectId,
  databaseURL: `https://${projectId}-default-rtdb.firebaseio.com`,
});

const firestore = admin.firestore();
const rtdb = admin.database();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

type AuthedRequest = Request & {
  session?: SessionSnapshot;
};

function badRequest(message: string): never {
  throw new HttpsError("invalid-argument", message);
}

function notFound(message: string): never {
  throw new HttpsError("not-found", message);
}

function forbidden(message: string): never {
  throw new HttpsError("permission-denied", message);
}

function internal(message: string): never {
  throw new HttpsError("internal", message);
}

function getHeader(req: Request, name: string): string | undefined {
  const value = req.header(name);
  if (value) return value;
  const lower = req.headers[name.toLowerCase()];
  return Array.isArray(lower) ? lower[0] : lower;
}

function twilioAuthHeader(): string | null {
  const apiKeySid = twilioApiKeySid.value() || process.env.TWILIO_API_KEY_SID;
  const apiKeySecret = twilioApiKeySecret.value() || process.env.TWILIO_API_KEY_SECRET;
  if (apiKeySid && apiKeySecret) {
    return `Basic ${Buffer.from(`${apiKeySid}:${apiKeySecret}`).toString("base64")}`;
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (accountSid && authToken) {
    return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
  }

  return null;
}

async function nextSequenceId(): Promise<number> {
  const ref = firestore.doc("_meta/counters/tags/current");
  let next = 1;
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = (snap.exists ? (snap.get("sequenceId") as number | undefined) : undefined) ?? 0;
    next = current + 1;
    tx.set(ref, {
      sequenceId: next,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  return next;
}

async function loadSessionByToken(token: string): Promise<SessionSnapshot | null> {
  const tokenHash = sha256(token);
  const snap = await rtdb.ref("sessions").orderByChild("tokenHash").equalTo(tokenHash).get();
  if (!snap.exists()) return null;

  const value = snap.val() as Record<string, SessionRecord>;
  const [id, data] = Object.entries(value)[0];
  return { id, data };
}

async function loadAuthedSession(req: Request): Promise<SessionSnapshot> {
  const auth = getHeader(req, "authorization");
  if (!auth?.startsWith("Bearer ")) {
    forbidden("Missing bearer token");
  }

  const token = auth.slice("Bearer ".length).trim();
  const session = await loadSessionByToken(token);
  if (!session) forbidden("Session not found");

  const sessionData = session.data;
  const now = nowMs();
  if (sessionData.revoked) forbidden("Session revoked");
  if (sessionData.status !== "ACTIVE") forbidden(`Session not active: ${sessionData.status}`);
  if (sessionData.expiresAt <= now) forbidden("Session expired");

  return session;
}

async function requireAuthed(req: Request): Promise<{ session: SessionSnapshot; userId: string }> {
  const session = await loadAuthedSession(req);
  const userId = session.data.userId;
  if (!userId) forbidden("Session missing user");
  return { session, userId };
}

async function getUser(userId: string): Promise<UserRecord | null> {
  const snap = await firestore.collection("users").doc(userId).get();
  return snap.exists ? (snap.data() as UserRecord) : null;
}

async function getPrinterByUuid(uuid: string): Promise<{ id: string; data: PrinterRecord } | null> {
  const snap = await firestore.collection("printers").where("uuid", "==", uuid).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, data: doc.data() as PrinterRecord };
}

async function getActivePrinterForEvent(eventId: string): Promise<{ id: string; data: PrinterRecord } | null> {
  const snap = await firestore.collection("printers").where("eventId", "==", eventId).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, data: doc.data() as PrinterRecord };
}

async function compileZpl(tagId: string, tag: TagRecord, kid: any, user: UserRecord, event: EventRecord): Promise<string> {
  const template = event.zplTemplate;
  const values: Record<string, string | null | undefined> = {
    "kid.firstName": kid.firstName ?? "",
    "kid.lastName": kid.lastName ?? "",
    "kid.birthYear": kid.birthYear ? String(kid.birthYear) : "",
    "kid.age": ageFromBirthYear(kid.birthYear),
    "kid.initials": initials(kid.firstName, kid.lastName),
    "user.firstName": user.firstName ?? "",
    "user.lastName": user.lastName ?? "",
    "user.phonePrefix": user.phonePrefix ?? "",
    "user.phone": user.phone ?? "",
    "user.email": user.email ?? "",
    "tag.publicCode": tag.publicCode,
    "tag.sequenceId": String(tag.sequenceId),
    "printJob.scanCode": tag.publicCode,
    "printer.uuid": tag.printerId,
    "event.name": event.name,
    "event.location": event.location ?? "",
    "event.sponsorImageUrl": event.sponsorImageUrl ?? "",
    "event.sponsorText": event.sponsorText ?? "",
    "tag.id": tagId,
  };

  return compileTemplate(template, values);
}

async function startAuth(req: Request, res: Response): Promise<void> {
  const body = req.body as AuthRequestBody;
  const phone = normalizePhone(body.phonePrefix, body.phone);
  if (!phone) badRequest("Phone is required");

  const sessionId = firestore.collection("_tmp").doc().id;
  const expiresAt = nowMs() + 10 * 60 * 1000;
  const ipHash = sha256(getHeader(req, "x-forwarded-for") ?? req.ip ?? "");
  const userAgentHash = sha256(getHeader(req, "user-agent") ?? "");

  const sessionRef = rtdb.ref(`sessions/${sessionId}`);
  await sessionRef.set({
    phone,
    status: "INITIALIZING",
    statusReason: "pending verification",
    createdAt: nowMs(),
    codeSentAt: null,
    expiresAt,
    twilioSid: null,
    tokenHash: null,
    userId: null,
    scope: "public",
    revoked: false,
    ipHash,
    userAgentHash,
  } satisfies SessionRecord);

  const twilio = await twilioStartVerification(phone);
  await sessionRef.update({
    status: "CODE_SENT",
    statusReason: twilio.disabled ? "local bypass" : "code sent",
    codeSentAt: nowMs(),
    twilioSid: twilio.sid,
  });

  res.json({
    attemptId: sessionId,
    expiresAt,
    codeSent: true,
    localBypass: twilio.disabled,
  });
}

async function verifyAuth(req: Request, res: Response): Promise<void> {
  const body = req.body as VerifyRequestBody;
  const attemptId = body.attemptId?.trim();
  const code = body.code?.trim();
  const phone = normalizePhone(body.phonePrefix, body.phone);

  if (!attemptId) badRequest("attemptId is required");
  if (!code) badRequest("code is required");

  const sessionRef = rtdb.ref(`sessions/${attemptId}`);
  const snap = await sessionRef.get();
  if (!snap.exists()) notFound("Auth session not found");
  const session = snap.val() as SessionRecord;

  if (session.expiresAt <= nowMs()) {
    await sessionRef.update({ status: "EXPIRED", statusReason: "expired" });
    forbidden("Auth session expired");
  }

  if (phone && phone !== session.phone) {
    await sessionRef.update({ status: "FAILED", statusReason: "phone mismatch" });
    forbidden("Phone mismatch");
  }

  const twilio = await twilioVerifyCode(session.phone, code);
  if (!twilio.ok) {
    await sessionRef.update({ status: "FAILED", statusReason: twilio.reason });
    forbidden(twilio.reason);
  }

  const user = await findOrCreateUser(session.phone);
  const token = randomToken(32);
  const tokenHash = sha256(token);

  await sessionRef.update({
    status: "ACTIVE",
    statusReason: "verified",
    tokenHash,
    userId: user.id,
    revoked: false,
  });

  res.json({
    token,
    userId: user.id,
    phone: session.phone,
    status: "ACTIVE",
  });
}

async function findOrCreateUser(phone: string): Promise<{ id: string; data: UserRecord }> {
  const existing = await firestore.collection("users").where("phone", "==", phone).limit(1).get();
  if (!existing.empty) {
    const doc = existing.docs[0];
    await doc.ref.set({ lastLogin: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { id: doc.id, data: doc.data() as UserRecord };
  }

  const docRef = firestore.collection("users").doc();
  const record: UserRecord = {
    firstName: null,
    lastName: null,
    phonePrefix: phone.startsWith("+") ? phone.slice(0, 2) : null,
    phone,
    email: null,
    lastLogin: FieldValue.serverTimestamp() as never,
    isAdmin: false,
    approvedTnC: false,
    createdAt: FieldValue.serverTimestamp() as never,
    updatedAt: FieldValue.serverTimestamp() as never,
  };
  await docRef.set(record);
  return { id: docRef.id, data: record };
}

async function getMe(req: Request, res: Response): Promise<void> {
  const { userId } = await requireAuthed(req);
  const userSnap = await firestore.collection("users").doc(userId).get();
  if (!userSnap.exists) notFound("User not found");
  const kidsSnap = await firestore.collection("kids").where("userId", "==", userId).where("deleted", "==", false).get();
  res.json({
    user: { id: userSnap.id, ...userSnap.data() },
    kids: kidsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
  });
}

async function updateMe(req: Request, res: Response): Promise<void> {
  const { userId } = await requireAuthed(req);
  const body = req.body as Partial<UserRecord>;
  const payload: Partial<UserRecord> = {
    firstName: body.firstName,
    lastName: body.lastName,
    email: body.email,
    approvedTnC: body.approvedTnC,
    updatedAt: FieldValue.serverTimestamp() as never,
  };
  await firestore.collection("users").doc(userId).set(payload, { merge: true });
  await getMe(req, res);
}

async function createKid(req: Request, res: Response): Promise<void> {
  const { userId } = await requireAuthed(req);
  const body = req.body as Partial<KidRecord>;
  const docRef = firestore.collection("kids").doc();
  const payload: KidRecord = {
    userId,
    firstName: body.firstName ?? null,
    lastName: body.lastName ?? null,
    birthYear: body.birthYear ?? null,
    deleted: false,
    deletedAt: null,
    createdAt: FieldValue.serverTimestamp() as never,
    updatedAt: FieldValue.serverTimestamp() as never,
  };
  await docRef.set(payload);
  await getMe(req, res);
}

async function updateKid(req: Request, res: Response): Promise<void> {
  const { userId } = await requireAuthed(req);
  const kidId = String(req.params.kidId);
  const snap = await firestore.collection("kids").doc(kidId).get();
  if (!snap.exists) notFound("Kid not found");
  const kid = snap.data() as KidRecord;
  if (kid.userId !== userId) forbidden("Kid ownership mismatch");

  const body = req.body as Partial<KidRecord>;
  await snap.ref.set({
    firstName: body.firstName ?? kid.firstName,
    lastName: body.lastName ?? kid.lastName,
    birthYear: body.birthYear ?? kid.birthYear,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await getMe(req, res);
}

async function deleteKid(req: Request, res: Response): Promise<void> {
  const { userId } = await requireAuthed(req);
  const kidId = String(req.params.kidId);
  const snap = await firestore.collection("kids").doc(kidId).get();
  if (!snap.exists) notFound("Kid not found");
  const kid = snap.data() as KidRecord;
  if (kid.userId !== userId) forbidden("Kid ownership mismatch");

  await snap.ref.set({
    deleted: true,
    deletedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await getMe(req, res);
}

async function createTag(req: Request, res: Response): Promise<void> {
  const { userId } = await requireAuthed(req);
  const body = req.body as TagCreateBody;

  if (!body.kidId || !body.printerId || !body.eventId) {
    badRequest("kidId, printerId, and eventId are required");
  }

  const kidSnap = await firestore.collection("kids").doc(body.kidId).get();
  if (!kidSnap.exists) notFound("Kid not found");
  const kid = kidSnap.data() as KidRecord;
  if (kid.userId !== userId) forbidden("Kid ownership mismatch");
  if (kid.deleted) forbidden("Kid deleted");

  const eventSnap = await firestore.collection("events").doc(body.eventId).get();
  if (!eventSnap.exists) notFound("Event not found");
  const event = eventSnap.data() as EventRecord;
  if (event.status !== "ACTIVE") forbidden("Event not active");

  const printerSnap = await firestore.collection("printers").doc(body.printerId).get();
  if (!printerSnap.exists) notFound("Printer not found");
  const printer = printerSnap.data() as PrinterRecord;

  const sequenceId = await nextSequenceId();
  const tagId = firestore.collection("tags").doc().id;
  const publicCode = toShortCode(sequenceId);

  const tag: TagRecord = {
    userId,
    kidId: body.kidId,
    printerId: body.printerId,
    eventId: body.eventId,
    sequenceId,
    publicCode,
    status: "CREATED",
    printStatus: "Pending",
    printedStatusTime: null,
    printStatusReason: null,
    createdAt: FieldValue.serverTimestamp() as never,
    updatedAt: FieldValue.serverTimestamp() as never,
  };

  await firestore.collection("tags").doc(tagId).set(tag);
  res.json({ id: tagId, ...tag, printerUuid: printer.uuid });
}

async function getKidScans(req: Request, res: Response): Promise<void> {
  const { userId } = await requireAuthed(req);
  const kidId = String(req.params.kidId);
  const kidSnap = await firestore.collection("kids").doc(kidId).get();
  if (!kidSnap.exists) notFound("Kid not found");
  const kid = kidSnap.data() as KidRecord;
  if (kid.userId !== userId) forbidden("Kid ownership mismatch");

  const scansSnap = await firestore.collection("scans").where("kidId", "==", kidId).orderBy("createdAt", "desc").limit(25).get();
  res.json(scansSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
}

async function createScan(req: Request, res: Response): Promise<void> {
  const { userId } = await requireAuthed(req);
  const publicCode = String(req.params.publicCode);
  const body = req.body as { lat?: number; lon?: number; location?: string; locationId?: string };

  const tagSnap = await firestore.collection("tags").where("publicCode", "==", publicCode).limit(1).get();
  if (tagSnap.empty) notFound("Tag not found");
  const tagDoc = tagSnap.docs[0];
  const tag = tagDoc.data() as TagRecord;
  if (tag.userId !== userId) forbidden("Tag ownership mismatch");

  const [kidSnap, parentUserSnap] = await Promise.all([
    firestore.collection("kids").doc(tag.kidId).get(),
    firestore.collection("users").doc(tag.userId).get(),
  ]);

  if (!kidSnap.exists) notFound("Kid not found");
  if (!parentUserSnap.exists) notFound("User not found");

  const kid = kidSnap.data() as KidRecord;
  const parentUser = parentUserSnap.data() as UserRecord;

  const scanRef = firestore.collection("scans").doc();
  const scan: ScanRecord = {
    tagId: tagDoc.id,
    publicCode,
    userId: tag.userId,
    kidId: tag.kidId,
    location: body.location ?? null,
    locationId: body.locationId ?? null,
    scannerPhone: null,
    lat: body.lat ?? null,
    lon: body.lon ?? null,
    securityMetadata: {
      ip: getHeader(req, "x-forwarded-for") ?? req.ip ?? null,
      userAgent: getHeader(req, "user-agent") ?? null,
      referer: getHeader(req, "referer") ?? null,
      createdAt: nowMs(),
    },
    createdAt: FieldValue.serverTimestamp() as never,
    updatedAt: FieldValue.serverTimestamp() as never,
  };
  await scanRef.set(scan);
  res.json({
    id: scanRef.id,
    ...scan,
    user: { id: parentUserSnap.id, ...parentUser },
    kid: { id: kidSnap.id, ...kid },
  });
}

async function registerPrinter(req: Request, res: Response): Promise<void> {
  const body = req.body as PrinterRegisterBody;
  const uuid = body.uuid?.trim();
  if (!uuid) badRequest("uuid is required");

  const firmwareVersion = Number(body.firmwareVersion ?? 0);
  const apiKey = randomToken(16);
  const existing = await getPrinterByUuid(uuid);
  const printerId = existing?.id ?? firestore.collection("printers").doc().id;

  const payload: Partial<PrinterRecord> = {
    uuid,
    firmwareVersion,
    apiKey,
    updatedAt: FieldValue.serverTimestamp() as never,
  };
  if (!existing) {
    Object.assign(payload, {
      status: "OFFLINE" as const,
      createdAt: FieldValue.serverTimestamp() as never,
    });
  }

  if (existing) {
    await firestore.collection("printers").doc(printerId).set(payload, { merge: true });
  } else {
    await firestore.collection("printers").doc(printerId).set(payload);
  }

  res.json({
    id: printerId,
    uuid,
    firmwareVersion,
    apiKey,
  });
}

async function twilioStartVerification(phone: string): Promise<{ sid: string | null; disabled: boolean }> {
  const serviceSid = twilioVerifyServiceSid.value() || process.env.TWILIO_VERIFY_SERVICE_SID;
  const authHeader = twilioAuthHeader();
  const disabled = process.env.TWILIO_VERIFY_DISABLED === "true" || !serviceSid || !authHeader;

  if (disabled) {
    return { sid: "local-bypass", disabled: true };
  }

  const response = await fetch(`https://verify.twilio.com/v2/Services/${serviceSid}/Verifications`, {
    method: "POST",
    headers: {
      Authorization: authHeader as string,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      To: phone,
      Channel: "sms",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Twilio verify start failed: ${response.status} ${text}`);
  }

  const json = await response.json() as { sid?: string };
  return { sid: json.sid ?? null, disabled: false };
}

async function twilioVerifyCode(phone: string, code: string): Promise<{ ok: boolean; reason: string }> {
  const serviceSid = twilioVerifyServiceSid.value() || process.env.TWILIO_VERIFY_SERVICE_SID;
  const authHeader = twilioAuthHeader();
  const disabled = process.env.TWILIO_VERIFY_DISABLED === "true" || !serviceSid || !authHeader;

  if (disabled) {
    return { ok: code === "000000", reason: "local bypass requires code 000000" };
  }

  const response = await fetch(`https://verify.twilio.com/v2/Services/${serviceSid}/VerificationCheck`, {
    method: "POST",
    headers: {
      Authorization: authHeader as string,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      To: phone,
      Code: code,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    return { ok: false, reason: `Twilio verify failed: ${response.status} ${text}` };
  }

  const json = await response.json() as { status?: string };
  return { ok: json.status === "approved", reason: "verification not approved" };
}

async function enqueuePrintJob(tagId: string, tag: TagRecord): Promise<void> {
  const [kidSnap, userSnap, eventSnap] = await Promise.all([
    firestore.collection("kids").doc(tag.kidId).get(),
    firestore.collection("users").doc(tag.userId).get(),
    firestore.collection("events").doc(tag.eventId).get(),
  ]);

  if (!kidSnap.exists || !userSnap.exists || !eventSnap.exists) {
    throw new Error("Missing record for tag print compilation");
  }

  const kid = kidSnap.data() as any;
  const user = userSnap.data() as UserRecord;
  const event = eventSnap.data() as EventRecord;
  const zpl = await compileZpl(tagId, tag, kid, user, event);

  const queueJob: PrinterQueueJob = {
    tagId,
    status: "QUEUED",
    createdAt: nowMs(),
    claimedAt: null,
    printingAt: null,
    doneAt: null,
    failedAt: null,
    failedReason: null,
    zpl,
    jobType: "tag-print",
    version: tag.sequenceId,
  };

  await rtdb.ref(`printerQueues/${tag.printerId}/jobs/${tagId}`).set(queueJob);
  await firestore.collection("tags").doc(tagId).set({
    status: "PRINT_QUEUED",
    printStatus: "Pending",
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

export const api = onRequest({
  region: "us-central1",
  secrets: [twilioApiKeySid, twilioApiKeySecret, twilioVerifyServiceSid],
}, app);

app.post("/auth/start", (req, res) => {
  startAuth(req, res).catch((error) => {
    console.error(error);
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  });
});

app.post("/auth/verify", (req, res) => {
  verifyAuth(req, res).catch((error) => {
    console.error(error);
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  });
});

app.get("/me", (req, res) => {
  getMe(req, res).catch((error) => {
    console.error(error);
    res.status(403).json({ error: error instanceof Error ? error.message : String(error) });
  });
});

app.put("/me", (req, res) => {
  updateMe(req, res).catch((error) => {
    console.error(error);
    res.status(403).json({ error: error instanceof Error ? error.message : String(error) });
  });
});

app.post("/kids", (req, res) => {
  createKid(req, res).catch((error) => {
    console.error(error);
    res.status(403).json({ error: error instanceof Error ? error.message : String(error) });
  });
});

app.put("/kids/:kidId", (req, res) => {
  updateKid(req, res).catch((error) => {
    console.error(error);
    res.status(403).json({ error: error instanceof Error ? error.message : String(error) });
  });
});

app.delete("/kids/:kidId", (req, res) => {
  deleteKid(req, res).catch((error) => {
    console.error(error);
    res.status(403).json({ error: error instanceof Error ? error.message : String(error) });
  });
});

app.post("/tags", (req, res) => {
  createTag(req, res).catch((error) => {
    console.error(error);
    res.status(403).json({ error: error instanceof Error ? error.message : String(error) });
  });
});

app.get("/kids/:kidId/scans", (req, res) => {
  getKidScans(req, res).catch((error) => {
    console.error(error);
    res.status(403).json({ error: error instanceof Error ? error.message : String(error) });
  });
});

app.post("/scans/:publicCode", (req, res) => {
  createScan(req, res).catch((error) => {
    console.error(error);
    res.status(403).json({ error: error instanceof Error ? error.message : String(error) });
  });
});

app.post("/printers/register", (req, res) => {
  registerPrinter(req, res).catch((error) => {
    console.error(error);
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  });
});

export const tagCreated = onDocumentCreated("tags/{tagId}", async (event) => {
  const snapshot = event.data;
  if (!snapshot) return;
  const tagId = snapshot.id;
  const tag = snapshot.data() as TagRecord;
  if (tag.printStatus !== "Pending" && tag.status !== "CREATED") {
    return;
  }
  await enqueuePrintJob(tagId, tag);
});

export const queueUpdated = onValueWritten("printerQueues/{printerId}/jobs/{jobId}", async (event) => {
  const job = event.data?.after.val() as PrinterQueueJob | null;
  if (!job) return;
  await mirrorTerminalState(String(event.params.printerId), String(event.params.jobId), job);
});

export const checkPrinterStatus = onSchedule("every 5 minutes", async () => {
  const staleBefore = nowMs() - (5 * 60 * 1000);
  const snap = await rtdb.ref("printerHealth").get();
  if (!snap.exists()) return;
  const printers = snap.val() as Record<string, PrinterHealthRecord>;
  const updates: Array<Promise<unknown>> = [];

  for (const [printerId, health] of Object.entries(printers)) {
    if (health.lastSeenAt && health.lastSeenAt < staleBefore && health.online) {
      updates.push(rtdb.ref(`printerHealth/${printerId}`).update({
        online: false,
      }));
    }
  }

  await Promise.all(updates);
});

export const cleanupSessions = onSchedule("every 5 minutes", async () => {
  const snap = await rtdb.ref("sessions").get();
  if (!snap.exists()) return;
  const sessions = snap.val() as Record<string, SessionRecord>;
  const now = nowMs();

  const deletions: Array<Promise<unknown>> = [];
  for (const [sessionId, session] of Object.entries(sessions)) {
    if (session.expiresAt <= now || session.status === "FAILED" || session.status === "EXPIRED") {
      deletions.push(rtdb.ref(`sessions/${sessionId}`).remove());
    }
  }

  await Promise.all(deletions);
});

export const cleanupRuntimeJobs = onSchedule("every 5 minutes", async () => {
  const snap = await rtdb.ref("printerQueues").get();
  if (!snap.exists()) return;
  const printers = snap.val() as Record<string, { jobs?: Record<string, PrinterQueueJob> }>;
  const removals: Array<Promise<unknown>> = [];
  const cutoff = nowMs() - (24 * 60 * 60 * 1000);

  for (const [printerId, data] of Object.entries(printers)) {
    for (const [jobId, job] of Object.entries(data.jobs ?? {})) {
      if ((job.status === "DONE" || job.status === "FAILED" || job.status === "TIMEOUT" || job.status === "CANCELLED") && job.createdAt < cutoff) {
        removals.push(rtdb.ref(`printerQueues/${printerId}/jobs/${jobId}`).remove());
      }
    }
  }

  await Promise.all(removals);
});

async function mirrorTerminalState(printerId: string, jobId: string, job: PrinterQueueJob): Promise<void> {
  if (job.status !== "DONE" && job.status !== "FAILED" && job.status !== "TIMEOUT" && job.status !== "CANCELLED") {
    return;
  }

  const tagRef = firestore.collection("tags").doc(job.tagId);
  const patch: Record<string, unknown> = {
    status: job.status === "DONE" ? "PRINTED" : "PRINT_FAILED",
    printStatus: job.status === "DONE" ? "Printed" : "Failed",
    printedStatusTime: Timestamp.now(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (job.status !== "DONE") {
    patch.printStatusReason = job.failedReason ?? job.status;
  }

  await tagRef.set(patch, { merge: true });
  await rtdb.ref(`printerQueues/${printerId}/jobs/${jobId}`).remove();
}
