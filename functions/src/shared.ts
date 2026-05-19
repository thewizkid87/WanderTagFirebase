import crypto from "node:crypto";

export const SHORT_ID_EPOCH = new Date("2020-01-01T00:00:00.000Z");

export type PrintStatus = "Pending" | "Printed" | "Failed";
export type SessionStatus = "INITIALIZING" | "CODE_SENT" | "ACTIVE" | "ERROR" | "FAILED" | "EXPIRED";
export type TagStatus = "CREATED" | "PRINT_QUEUED" | "PRINTED" | "PRINT_FAILED" | "DELETED";
export type PrinterStatus = "ONLINE" | "OFFLINE" | "DEGRADED" | "DISABLED";
export type PrinterDeviceStatus = "OK" | "OUT_OF_PAPER" | "HEAD_OPEN" | "PAUSED" | "RIBBON_OUT" | "ERROR_NO_HS";
export type PrintJobStatus = "QUEUED" | "CLAIMED" | "PRINTING" | "DONE" | "FAILED" | "TIMEOUT" | "CANCELLED";

export interface BaseRecord {
  id?: string;
  createdAt?: FirebaseFirestore.Timestamp | Date | number;
  updatedAt?: FirebaseFirestore.Timestamp | Date | number;
}

export interface UserRecord extends BaseRecord {
  firstName?: string | null;
  lastName?: string | null;
  phonePrefix?: string | null;
  phone?: string | null;
  email?: string | null;
  lastLogin?: FirebaseFirestore.Timestamp | Date | number | null;
  isAdmin?: boolean;
  approvedTnC?: boolean;
}

export interface KidRecord extends BaseRecord {
  userId: string;
  firstName?: string | null;
  lastName?: string | null;
  birthYear?: number | null;
  deleted?: boolean;
  deletedAt?: FirebaseFirestore.Timestamp | Date | number | null;
}

export interface EventRecord extends BaseRecord {
  name: string;
  zplTemplate: string;
  fromDate: FirebaseFirestore.Timestamp | Date | number;
  toDate: FirebaseFirestore.Timestamp | Date | number;
  status: "PENDING" | "ACTIVE" | "COMPLETED" | "CANCELLED" | "EXPIRED";
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  location?: string | null;
  sponsorImageUrl?: string | null;
  sponsorText?: string | null;
}

export interface PrinterRecord extends BaseRecord {
  uuid: string;
  status: PrinterStatus;
  firmwareVersion: number;
  apiKey?: string;
  eventId?: string | null;
  location?: string | null;
}

export interface TagRecord extends BaseRecord {
  userId: string;
  kidId: string;
  printerId: string;
  eventId: string;
  sequenceId: number;
  publicCode: string;
  status: TagStatus;
  printStatus: PrintStatus;
  printedStatusTime?: FirebaseFirestore.Timestamp | Date | number | null;
  printStatusReason?: string | null;
}

export interface ScanRecord extends BaseRecord {
  tagId: string;
  publicCode: string;
  userId: string;
  kidId: string;
  location?: string | null;
  locationId?: string | null;
  scannerPhone?: string | null;
  lat?: number | null;
  lon?: number | null;
  securityMetadata?: Record<string, unknown> | null;
}

export interface SessionRecord extends BaseRecord {
  phone: string;
  status: SessionStatus;
  statusReason?: string | null;
  createdAt?: number;
  codeSentAt?: number | null;
  expiresAt: number;
  twilioSid?: string | null;
  tokenHash?: string | null;
  userId?: string | null;
  scope?: string | null;
  revoked?: boolean;
  ipHash?: string | null;
  userAgentHash?: string | null;
}

export interface PrinterHealthRecord extends BaseRecord {
  online: boolean;
  lastSeenAt?: number | null;
  currentJobId?: string | null;
  firmwareVersion?: number | null;
  localIp?: string | null;
  rawPrinterStatus?: string | null;
  printerDeviceStatus?: PrinterDeviceStatus | null;
  lastErrorTime?: number | null;
  lastErrorDetails?: string | null;
  lastActiveTime?: number | null;
}

export interface PrinterQueueJob extends BaseRecord {
  tagId: string;
  status: PrintJobStatus;
  createdAt: number;
  claimedAt?: number | null;
  printingAt?: number | null;
  doneAt?: number | null;
  failedAt?: number | null;
  failedReason?: string | null;
  zpl: string;
  jobType?: string | null;
  version?: number | null;
}

export interface FirmwareRecord extends BaseRecord {
  version: number;
  checksum: string;
  body: string;
  updatedAt: number;
}

export interface AuthRequestBody {
  phonePrefix?: string;
  phone?: string;
}

export interface VerifyRequestBody extends AuthRequestBody {
  attemptId?: string;
  code?: string;
}

export interface PrinterRegisterBody {
  uuid?: string;
  firmwareVersion?: number;
}

export interface TagCreateBody {
  userId?: string;
  kidIds?: string[];
  printerId?: string;
}

export interface SessionSnapshot {
  id: string;
  data: SessionRecord;
}

export function nowMs(): number {
  return Date.now();
}

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function normalizePhone(prefix?: string, phone?: string): string {
  return `${prefix ?? ""}${phone ?? ""}`.replace(/\s+/g, "");
}

export function daysSinceShortIdEpoch(date: Date = new Date()): number {
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const diff = utcDate.getTime() - SHORT_ID_EPOCH.getTime();
  return Math.floor(diff / (24 * 60 * 60 * 1000));
}

export function toShortCode(sequenceId: number, date: Date = new Date()): string {
  const days = daysSinceShortIdEpoch(date);
  const dateHex = days.toString(16).toUpperCase().padStart(4, "0");
  const seqHex = sequenceId.toString(16);
  return `${dateHex}_${seqHex}`;
}

export function parseShortCode(code: string): { daysSinceEpoch: number; sequenceId: number } {
  const [dateHex, seqHex] = code.split("_");
  if (!dateHex || !seqHex) {
    throw new Error("Invalid scan code format");
  }
  return {
    daysSinceEpoch: Number.parseInt(dateHex, 16),
    sequenceId: Number.parseInt(seqHex, 16),
  };
}

export function initials(firstName?: string | null, lastName?: string | null): string {
  const bits = [firstName?.[0], lastName?.[0]].filter(Boolean).join(".");
  return bits ? `${bits}.`.toUpperCase() : "";
}

export function ageFromBirthYear(birthYear?: number | null): string {
  if (!birthYear) return "";
  const currentYear = new Date().getUTCFullYear();
  return String(currentYear - birthYear);
}

export function compileTemplate(template: string, values: Record<string, string | null | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*}}/g, (_, key: string) => values[key] ?? "");
}
