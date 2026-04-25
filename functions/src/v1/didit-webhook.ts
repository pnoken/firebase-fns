import { onRequest } from "firebase-functions/v2/https";
import type { Request, Response } from "express";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import * as crypto from "crypto";

admin.initializeApp();
const db = admin.firestore();

// Didit webhook secret (set via Firebase CLI)
const DIDIT_WEBHOOK_SECRET = defineSecret("DIDIT_WEBHOOK_SECRET");

function digitsOnly(v: unknown): string {
    return String(v ?? "").replace(/\D/g, "");
}

function normalizePhoneVariants(raw: string): string[] {
    const digits = digitsOnly(raw);
    if (!digits) return [];

    let national = digits;
    if (national.startsWith("233")) national = national.slice(3);
    else if (national.startsWith("0")) national = national.slice(1);

    if (national.length > 9) national = national.slice(-9);

    const out = new Set<string>();
    out.add(national);
    out.add(`0${national}`);
    out.add(`233${national}`);
    out.add(`+233${national}`);
    return Array.from(out);
}

async function findUserByVendorData(vendorData: unknown): Promise<{ userId: string } | null> {
    const raw = String(vendorData ?? "").trim();
    if (!raw) return null;

    // vendor_data is session.userId (doc id) from create-didit-session. Try direct doc lookup first.
    // Firestore doc IDs are case-sensitive; try exact match then lowercase (for wallet-address doc ids).
    const docIdsToTry = [...new Set([raw, raw.toLowerCase()])];
    for (const docId of docIdsToTry) {
        if (!docId) continue;
        try {
            const snap = await db.collection("users").doc(docId).get();
            if (snap.exists) return { userId: snap.id };
        } catch {
            // ignore
        }
    }

    // Fallback: treat vendor_data as mobileNumber (legacy / alternate config)
    const variants = normalizePhoneVariants(raw);
    if (variants.length === 0) return null;
    const snap = await db.collection("users").where("mobileNumber", "in", variants.slice(0, 10)).limit(1).get();
    if (snap.empty) return null;
    return { userId: snap.docs[0].id };
}

function isValidHexSha256(value: string): boolean {
    return /^[a-f0-9]{64}$/i.test(value);
}

function isProbablyBase64Sha256(value: string): boolean {
    // base64(sha256) is typically 44 chars with optional '=' padding
    return /^[A-Za-z0-9+/]{43,44}={0,2}$/.test(value);
}

function verifyDiditSignature(rawBody: string, signature: string | null, timestamp: string | null, secret: string): boolean {
    if (!signature || !timestamp || !secret) return false;

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;

    // 5 minute replay window
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - ts) > 5 * 60) return false;

    const sig = signature.trim();

    // Providers may sign slightly different payload formats depending on header version.
    const payloadCandidates = [
        `${timestamp}.${rawBody}`,
        rawBody,
        `${rawBody}.${timestamp}`,
    ];

    const expectedBuffers = payloadCandidates.map((p) => crypto.createHmac("sha256", secret).update(p).digest());

    try {
        if (isValidHexSha256(sig)) {
            const provided = Buffer.from(sig, "hex");
            return expectedBuffers.some((expected) => crypto.timingSafeEqual(expected, provided));
        }
        if (isProbablyBase64Sha256(sig)) {
            const provided = Buffer.from(sig, "base64");
            return expectedBuffers.some((expected) => crypto.timingSafeEqual(expected, provided));
        }
        return false;
    } catch {
        return false;
    }
}

function getSignatureHeader(req: any): { signature: string | null; timestamp: string | null } {
    const signature =
        req.get("x-signature-v2") ||
        req.get("x-signature-simple") ||
        req.get("x-signature") ||
        null;
    const timestamp = req.get("x-timestamp") || null;
    return { signature, timestamp };
}

function parseStatus(raw: unknown): "Approved" | "Declined" | "Pending" | "Unknown" {
    const s = String(raw ?? "").trim();
    if (s === "Approved") return "Approved";
    if (s === "Declined") return "Declined";
    if (s === "Pending") return "Pending";
    return "Unknown";
}

export const diditWebhook = onRequest(
    {
        invoker: "public",
        region: "us-central1",
        cors: true,
        secrets: [DIDIT_WEBHOOK_SECRET],
        timeoutSeconds: 60,
    },
    async (req: Request, res: Response) => {
        if (req.method === "GET") {
            res.status(200).json({ ok: true, function: "diditWebhook", timestamp: new Date().toISOString() });
            return;
        }
        if (req.method !== "POST") {
            res.status(405).json({ ok: false, error: "Method not allowed" });
            return;
        }

        const secret = String(DIDIT_WEBHOOK_SECRET.value() || "").trim();
        if (!secret) {
            res.status(500).json({ ok: false, error: "Server not configured" });
            return;
        }

        // We need the exact raw body string for signature verification.
        // In Firebase Functions, `req.rawBody` may be a Buffer, Uint8Array, or string depending on runtime/middleware.
        const rawBody = (() => {
            const rb = (req as any).rawBody as Buffer | Uint8Array | string | undefined;
            if (typeof rb === "string") return rb;
            if (rb && (Buffer.isBuffer(rb) || rb instanceof Uint8Array)) {
                return Buffer.from(rb).toString("utf8");
            }
            return JSON.stringify(req.body ?? {});
        })();

        const { signature, timestamp } = getSignatureHeader(req);
        const okSig = verifyDiditSignature(rawBody, signature, timestamp, secret);
        if (!okSig) {
            logger.warn("Didit webhook signature invalid", {
                hasSignature: Boolean(signature),
                hasTimestamp: Boolean(timestamp),
                signatureLength: signature ? String(signature).trim().length : 0,
                signatureLooksHex: signature ? isValidHexSha256(String(signature).trim()) : false,
                contentType: req.get("content-type") || null,
                rawBodyLength: rawBody.length,
                rawBodyStartsWith: rawBody.slice(0, 1),
            });
            res.status(401).json({ ok: false, error: "Invalid signature" });
            return;
        }

        const payload = (req.body || {}) as any;
        const sessionId = String(payload?.session_id || payload?.decision?.session_id || "").trim() || null;
        const status = parseStatus(payload?.status || payload?.decision?.status);
        const vendorData = payload?.vendor_data ?? payload?.decision?.vendor_data ?? payload?.metadata?.mobileNumber ?? null;

        const user = await findUserByVendorData(vendorData);
        if (!user) {
            // Still return 200 so Didit doesn't retry forever if vendor_data is wrong.
            logger.warn("Didit webhook unmatched user", {
                sessionId,
                status,
                vendorDataType: typeof vendorData,
            });
            res.status(200).json({ ok: true, unmatched: true });
            return;
        }

        // Map Didit status to app kycStatus format (matches Next.js didit-webhook)
        const kycStatus = status === "Approved" ? "verified" : status === "Pending" ? "pending" : "failed";

        const now = admin.firestore.FieldValue.serverTimestamp();
        const nowIso = new Date().toISOString();
        await db
            .collection("users")
            .doc(user.userId)
            .set(
                {
                    kycStatus,
                    kycVerificationId: sessionId,
                    kycVerifiedAt: kycStatus === "verified" ? nowIso : null,
                    updatedAt: nowIso,
                    didit: {
                        status,
                        sessionId,
                        webhookType: String(payload?.webhook_type || "").trim() || null,
                        workflowId: String(payload?.workflow_id || payload?.decision?.workflow_id || "").trim() || null,
                        lastWebhookAt: now,
                    },
                },
                { merge: true }
            );

        // Optional: store the raw event for audit/debug (bounded size)
        try {
            const id = `didit_${sessionId || Date.now()}`.slice(0, 220);
            await db.collection("didit_webhook_events").doc(id).set(
                {
                    sessionId,
                    userId: user.userId,
                    status,
                    receivedAt: now,
                    payload: payload ?? {},
                },
                { merge: true }
            );
        } catch {
            // ignore write failures
        }

        res.status(200).json({ ok: true });
    }
);

