import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import { ethers } from "ethers";
import * as crypto from "crypto";
import { diditWebhook } from "./v1/didit-webhook";

admin.initializeApp();
const db = admin.firestore();

// Secrets (set via Firebase CLI)
const RPC_URL = defineSecret("RPC_URL");
const MINTER_PRIVATE_KEY = defineSecret("MINTER_PRIVATE_KEY");

// Moolre (set via Firebase CLI)
const MOOLRE_API_USER = defineSecret("MOOLRE_API_USER");
const MOOLRE_API_KEY = defineSecret("MOOLRE_API_KEY"); // used for validate-mobile (X-API-KEY)
const MOOLRE_PUBLIC_KEY = defineSecret("MOOLRE_PUBLIC_KEY");
const MOOLRE_ACCOUNT_NUMBER = defineSecret("MOOLRE_ACCOUNT_NUMBER");
const MOOLRE_WEBHOOK_SECRET = defineSecret("MOOLRE_WEBHOOK_SECRET");
// Temporary debug switch: when set to "true", capture mismatched webhook secrets into Firestore.
const MOOLRE_CAPTURE_SECRET = defineSecret("MOOLRE_CAPTURE_SECRET");

// Vonage SMS (optional; used for deposit success SMS)
const VONAGE_API_KEY = defineSecret("VONAGE_API_KEY");
const VONAGE_API_SECRET = defineSecret("VONAGE_API_SECRET");
const VONAGE_SMS_FROM = defineSecret("VONAGE_SMS_FROM");

// Token config (optional secret; falls back to default)
const GHSFIAT_CONTRACT_ADDRESS = defineSecret("GHSFIAT_CONTRACT_ADDRESS");

// Contract configuration
const CONTRACT_ADDRESS = "0xEB86C28e5767504312926A71eB93Ff1B49De8Db7";
const CONTRACT_ABI = [
    {
        inputs: [
            { internalType: "address", name: "user", type: "address" },
            { internalType: "string", name: "userCountryCode", type: "string" },
            { internalType: "string", name: "hashedPhoneNumber", type: "string" },
        ],
        name: "mintVerifiedIdentity",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [{ internalType: "address", name: "user", type: "address" }],
        name: "getUserIdentity",
        outputs: [
            { internalType: "bool", name: "hasIdentity", type: "bool" },
            { internalType: "uint256", name: "tokenId", type: "uint256" },
            { internalType: "uint8", name: "level", type: "uint8" },
            { internalType: "uint256", name: "timestamp", type: "uint256" },
        ],
        stateMutability: "view",
        type: "function",
    },
];

// GHSFIAT minting configuration (minimal ABI: mint(to, amountWei))
const DEFAULT_GHSFIAT_ADDRESS = "0xC671BbdBDdC27DF67fd65b9AcD469c52b72aEC66";
const GHSFIAT_MINT_ABI = [
    {
        inputs: [
            { internalType: "address", name: "to", type: "address" },
            { internalType: "uint256", name: "amount", type: "uint256" },
        ],
        name: "mint",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
];

const ERC20_BALANCE_ABI = [
    {
        inputs: [{ internalType: "address", name: "account", type: "address" }],
        name: "balanceOf",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
];

function digitsOnly(raw: string): string {
    return String(raw || "").replace(/\D/g, "");
}

function normalizeVonageFrom(raw: string): string {
    const v = String(raw || "").trim();
    if (!v) return "Fiatsend";
    const hasLetters = /[a-zA-Z]/.test(v);
    if (hasLetters) return v.replace(/[^a-zA-Z0-9]/g, "").slice(0, 11) || "Fiatsend";
    return v.replace(/\D/g, "");
}

function normalizeSmsToDigits(phone: string): string {
    return digitsOnly(phone);
}

async function sendVonageSms(params: { to: string; text: string; clientRef: string }) {
    const apiKey = String(VONAGE_API_KEY.value() || "").trim();
    const apiSecret = String(VONAGE_API_SECRET.value() || "").trim();
    if (!apiKey || !apiSecret) {
        throw new Error("VONAGE_SMS_NOT_CONFIGURED");
    }

    const from = normalizeVonageFrom(String(VONAGE_SMS_FROM.value() || "Fiatsend"));
    const toDigits = normalizeSmsToDigits(params.to);
    if (!toDigits) {
        throw new Error("INVALID_PHONE_NUMBER");
    }

    const body = new URLSearchParams();
    body.set("api_key", apiKey);
    body.set("api_secret", apiSecret);
    body.set("to", toDigits);
    body.set("from", from);
    body.set("text", params.text);
    body.set("client-ref", params.clientRef);

    const resp = await fetch("https://rest.nexmo.com/sms/json", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });

    const data = (await resp.json().catch(() => ({}))) as any;
    const msg = data?.messages?.[0];
    const status = msg?.status;
    if (!resp.ok || status !== "0") {
        const errText = msg?.["error-text"] || data?.error || "SMS delivery failed";
        throw new Error(errText);
    }
}

async function sendDepositSmsOnce(params: { depositId: string; to: string; balanceGhs: string }) {
    const to = String(params.to || "").trim();
    if (!to) return;

    const docId = `deposit_${params.depositId}`.slice(0, 240);
    const ref = db.collection("sms_notifications").doc(docId);
    const now = admin.firestore.Timestamp.now();

    const snap = await ref.get();
    const existing = snap.exists ? (snap.data() as any) : null;
    if (existing?.status === "sent") return;

    try {
        if (!snap.exists) {
            await ref.create({
                kind: "deposit_success",
                depositId: params.depositId,
                phone: to,
                status: "sending",
                createdAt: now,
                updatedAt: now,
            });
        } else {
            await ref.set(
                { kind: "deposit_success", depositId: params.depositId, phone: to, status: "sending", updatedAt: now },
                { merge: true }
            );
        }
    } catch {
        return;
    }

    const text = `Fiatsend: You have successfully added money to your Fiatsend account. Your current balance is ${params.balanceGhs} GHS. Keep transacting on app.fiatsend.com`;
    try {
        await sendVonageSms({ to, text, clientRef: docId });
        await ref.set({ status: "sent", sentAt: now, updatedAt: now }, { merge: true });
    } catch (e: any) {
        await ref.set({ status: "failed", lastError: e?.message || "sms_send_failed", updatedAt: now }, { merge: true });
    }
}

function normalizeMoolreMsisdn(raw: string): string {
    const d = digitsOnly(raw);
    if (!d) return "";
    if (d.startsWith("233")) return d;
    if (d.startsWith("0") && d.length >= 10) return `233${d.slice(1)}`;
    if (d.length === 9) return `233${d}`;
    return d;
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

async function findUserByPhone(rawPhone: string): Promise<{ userId: string; wallet: string } | null> {
    const variants = normalizePhoneVariants(rawPhone);
    if (variants.length === 0) return null;
    const snap = await db.collection("users").where("mobileNumber", "in", variants.slice(0, 10)).limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    const data = doc.data() as any;
    const wallet = String(data?.walletOriginal || data?.wallet || doc.id || "").trim();
    if (!wallet || !ethers.isAddress(wallet)) return null;
    return { userId: doc.id, wallet };
}

function mapUssdNetworkToChannel(network: number | undefined): "13" | "6" | "7" {
    if (network === 6) return "6";
    if (network === 5) return "7";
    return "13";
}

function parseMoney(raw: unknown): { amountStr: string; amountNum: number } | null {
    const s = String(raw ?? "").trim().replace(/[^\d.]/g, "");
    const n = Number(s);
    if (!s || !Number.isFinite(n) || n <= 0) return null;
    const fixed = (Math.round(n * 100) / 100).toFixed(2);
    return { amountStr: fixed, amountNum: Number(fixed) };
}

function parseAmount(raw: unknown): number | null {
    const m = parseMoney(raw);
    return m ? m.amountNum : null;
}

function isOtpRequired(resp: any): boolean {
    const code = String(resp?.code || resp?.data?.code || "").toUpperCase();
    if (code === "TP14") return true;
    const msg = String(resp?.message || resp?.data?.message || "").toLowerCase();
    return msg.includes("verification") || msg.includes("otp");
}

function isOtpVerified(resp: any): boolean {
    const code = String(resp?.code || resp?.data?.code || "").toUpperCase();
    if (code === "TP17") return true;
    const msg = String(resp?.message || resp?.data?.message || "").toLowerCase();
    return msg.includes("verification successful");
}

function isInvalidOtp(resp: any): boolean {
    const code = String(resp?.code || resp?.data?.code || "").toUpperCase();
    if (code === "TP15") return true;
    const msg = String(resp?.message || resp?.data?.message || "").toLowerCase();
    return msg.includes("invalid otp") || msg.includes("invalid code");
}

function looksPromptSent(resp: any): boolean {
    const code = String(resp?.code || resp?.data?.code || "").toUpperCase();
    if (code === "TR099") return true;
    const status = resp?.status ?? resp?.data?.status ?? null;
    if (status === 1 || status === "1") return true;
    const msg = String(resp?.message || resp?.data?.message || "").toLowerCase();
    return msg.includes("prompt") || msg.includes("sent to customer's phone");
}

async function initiateMoolrePayment(params: {
    payer: string;
    channel: "13" | "6" | "7";
    amount: number;
    externalref: string;
    otpcode?: string;
    sessionid?: string;
}): Promise<any> {
    const apiUser = MOOLRE_API_USER.value();
    const pubKey = MOOLRE_PUBLIC_KEY.value();
    const accountNumber = MOOLRE_ACCOUNT_NUMBER.value();

    if (!apiUser || !pubKey || !accountNumber) {
        throw new Error("MOOLRE_NOT_CONFIGURED");
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
        const resp = await fetch("https://api.moolre.com/open/transact/payment", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-API-USER": apiUser,
                "X-API-PUBKEY": pubKey,
            },
            body: JSON.stringify({
                type: 1,
                channel: params.channel,
                currency: "GHS",
                payer: normalizeMoolreMsisdn(params.payer),
                amount: params.amount,
                externalref: params.externalref,
                otpcode: params.otpcode || "",
                reference: "Fiatsend Deposit",
                sessionid: params.sessionid || "",
                accountnumber: accountNumber,
            }),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const text = await resp.text();
        let data: any = null;
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            data = { status: 0, message: "invalid_json_response", raw: text?.slice?.(0, 200) };
        }
        data.__httpOk = resp.ok;
        data.__httpStatus = resp.status;
        return data;
    } catch (e: any) {
        clearTimeout(timeoutId);
        if (e?.name === "AbortError") throw new Error("MOOLRE_TIMEOUT");
        throw e;
    }
}

async function setUssdSession(sessionId: string, patch: Record<string, unknown>) {
    const now = admin.firestore.Timestamp.now();
    await db.collection("ussd_sessions").doc(sessionId).set({ sessionId, updatedAt: now, createdAt: now, ...patch }, { merge: true });
}

async function getUssdSession(sessionId: string) {
    const snap = await db.collection("ussd_sessions").doc(sessionId).get();
    return snap.exists ? (snap.data() as any) : null;
}

function parseUserIdFromExternalRef(externalref: string | null): string | null {
    const ref = String(externalref || "").trim();
    if (!ref.startsWith("FSDEP_")) return null;
    const parts = ref.split("_");
    return String(parts?.[1] || "").trim() || null;
}

function stableDepositId(externalref: string | null, transactionid: string | number | null, raw: string) {
    const base = String(externalref || "").trim() || (transactionid != null ? `moolre_${transactionid}` : "");
    if (base) return base.slice(0, 250);
    const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
    return `moolre_${hash}`.slice(0, 250);
}

function shortHash(s: string): string | null {
    const v = String(s || "").trim();
    if (!v) return null;
    return crypto.createHash("sha256").update(v).digest("hex").slice(0, 10);
}

async function submitGhsfiatMint(params: { wallet: string; amountStr: string }) {
    const rpcUrl = RPC_URL.value();
    const pk = MINTER_PRIVATE_KEY.value();
    if (!rpcUrl || !pk) throw new Error("MINT_NOT_CONFIGURED");

    const tokenAddress = (GHSFIAT_CONTRACT_ADDRESS.value() || "").trim() || DEFAULT_GHSFIAT_ADDRESS;
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(pk, provider);
    const contract = new ethers.Contract(tokenAddress, GHSFIAT_MINT_ABI, signer);
    const wei = ethers.parseUnits(params.amountStr, 18);
    const tx = await contract.mint(params.wallet, wei);
    return tx.hash as string;
}

function normalizeCountryCode(countryCode: string): string {
    return countryCode.replace(/^\+/, "").slice(0, 6);
}

function formatMintMessage(userAddress: string, phoneNumber: string, countryCode: string, timestamp: number): string {
    return `Mint identity NFT for ${userAddress}, phone: ${phoneNumber}, cc: ${countryCode}, ts: ${timestamp}`;
}

export const mintIdentity = onRequest(
    {
        cors: ["https://fiatsend.com", "https://app.fiatsend.com"],
        secrets: [RPC_URL, MINTER_PRIVATE_KEY],
    },
    async (req, res) => {
        if (req.method !== "POST") {
            res.status(405).json({ error: "Method not allowed" });
            return;
        }

        let tx;

        try {
            const { userAddress, phoneNumber, countryCode, timestamp, signature } = req.body || {};

            if (!userAddress || !ethers.isAddress(userAddress)) {
                res.status(400).json({ error: "Invalid user address" });
                return;
            }
            if (!phoneNumber || !countryCode || !signature || !timestamp) {
                res.status(400).json({ error: "Phone number, country code, signature, and timestamp required" });
                return;
            }

            // Replay protection
            const now = Date.now();
            const allowedSkew = 2 * 60 * 1000;
            if (Math.abs(now - timestamp) > allowedSkew) {
                res.status(400).json({ error: "Request expired/stale" });
                return;
            }

            // Signature check
            const msg = formatMintMessage(userAddress, phoneNumber, countryCode, timestamp);
            const recovered = ethers.verifyMessage(msg, signature);
            if (recovered.toLowerCase() !== userAddress.toLowerCase()) {
                res.status(401).json({ error: "Signature address mismatch" });
                return;
            }

            const normalizedCountryCode = normalizeCountryCode(countryCode);
            if (!/^\d{1,6}$/.test(normalizedCountryCode)) {
                res.status(400).json({ error: "Invalid country code format" });
                return;
            }

            // Provider + contract
            const rpcUrl = RPC_URL.value();
            const privateKey = MINTER_PRIVATE_KEY.value();

            const provider = new ethers.JsonRpcProvider(rpcUrl);
            const minterWallet = new ethers.Wallet(privateKey, provider);
            const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, minterWallet);

            // Already registered?
            let alreadyHasIdentity = false;
            let existingIdentity: any = null;
            try {
                existingIdentity = await contract.getUserIdentity(userAddress);
                // Result is an array-like object or Result object
                alreadyHasIdentity = !!existingIdentity?.[0];
            } catch (_) { }

            if (alreadyHasIdentity) {
                // Admin SDK writes use the Functions service account (bypasses Firestore security rules).
                const docId = userAddress.toLowerCase();
                const userRef = db.collection("users").doc(docId);

                const tokenId = existingIdentity?.[1] != null ? String(existingIdentity[1]) : null;
                const level = existingIdentity?.[2] != null ? Number(existingIdentity[2]) : null;
                const chainTimestamp = existingIdentity?.[3] != null ? String(existingIdentity[3]) : null;

                await userRef.set(
                    {
                        wallet: docId,
                        walletOriginal: userAddress,
                        mobileNumber: phoneNumber,
                        phoneHash: ethers.keccak256(ethers.toUtf8Bytes(phoneNumber)),
                        countryCode: normalizedCountryCode,
                        contractAddress: CONTRACT_ADDRESS,
                        identityMint: {
                            status: "minted",
                            tokenId,
                            level,
                            chainTimestamp,
                            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        },
                    },
                    { merge: true }
                );

                res.status(200).json({ success: true, alreadyRegistered: true });
                return;
            }

            // Hash phone
            const phoneHash = ethers.keccak256(ethers.toUtf8Bytes(phoneNumber));

            // Mint
            tx = await contract.mintVerifiedIdentity(userAddress, normalizedCountryCode, phoneHash);

            // Save to Firestore (idempotent: one doc per wallet)
            const docId = userAddress.toLowerCase();
            const userRef = db.collection("users").doc(docId);

            // 1) Record submission immediately (so we don't lose the txHash)
            await userRef.set(
                {
                    wallet: docId,
                    walletOriginal: userAddress,
                    mobileNumber: phoneNumber,
                    phoneHash,
                    countryCode: normalizedCountryCode,
                    contractAddress: CONTRACT_ADDRESS,
                    identityMint: {
                        status: "submitted",
                        txHash: tx.hash,
                        submittedAt: admin.firestore.FieldValue.serverTimestamp(),
                    },
                },
                { merge: true }
            );

            // 2) Wait for confirmation. If it confirms successfully, mark as minted.
            const receipt = await provider.waitForTransaction(tx.hash, 1, 120_000);
            if (!receipt) {
                res.status(202).json({
                    success: true,
                    txHash: tx.hash,
                    userAddress,
                    countryCode: normalizedCountryCode,
                    status: "submitted",
                    message: "Transaction submitted; awaiting confirmation.",
                });
                return;
            }

            if (receipt.status !== 1) {
                await userRef.set(
                    {
                        identityMint: {
                            status: "failed",
                            txHash: tx.hash,
                            failedAt: admin.firestore.FieldValue.serverTimestamp(),
                            receiptStatus: receipt.status,
                            blockNumber: receipt.blockNumber,
                        },
                    },
                    { merge: true }
                );
                res.status(500).json({ error: "Mint transaction failed." });
                return;
            }

            const mintedIdentity = await contract.getUserIdentity(userAddress);
            const hasIdentity = !!mintedIdentity?.[0];
            const tokenId = mintedIdentity?.[1] != null ? String(mintedIdentity[1]) : null;
            const level = mintedIdentity?.[2] != null ? Number(mintedIdentity[2]) : null;
            const chainTimestamp = mintedIdentity?.[3] != null ? String(mintedIdentity[3]) : null;

            await userRef.set(
                {
                    identityMint: {
                        status: hasIdentity ? "minted" : "minted_unverified",
                        txHash: tx.hash,
                        transactionHash: receipt.hash,
                        blockNumber: receipt.blockNumber,
                        tokenId,
                        level,
                        chainTimestamp,
                        mintedAt: admin.firestore.FieldValue.serverTimestamp(),
                    },
                },
                { merge: true }
            );

            res.status(200).json({
                success: true,
                txHash: tx.hash,
                userAddress,
                countryCode: normalizedCountryCode,
                message: "Transaction confirmed and saved successfully.",
            });
        } catch (err: any) {
            res.status(500).json({ error: err?.message || "Server error" });
        }
    }
);

// Re-export Didit webhook HTTPS function
export { diditWebhook };

/**
 * Ensures DB eventually reflects on-chain mint outcome.
 * - Any `users/*` doc with `identityMint.status == "submitted"` will be checked.
 * - If tx is confirmed successfully, the doc is updated to `minted`.
 * - If tx is confirmed but failed, the doc is updated to `failed`.
 */
export const syncIdentityMints = onSchedule(
    {
        schedule: "every 5 minutes",
        secrets: [RPC_URL],
        timeoutSeconds: 300,
    },
    async () => {
        const provider = new ethers.JsonRpcProvider(RPC_URL.value());
        const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);

        const snapshot = await db
            .collection("users")
            .where("identityMint.status", "==", "submitted")
            .limit(50)
            .get();

        if (snapshot.empty) return;

        await Promise.all(
            snapshot.docs.map(async (doc) => {
                const data = doc.data() || {};
                const txHash = data?.identityMint?.txHash;
                if (!txHash) return;

                const receipt = await provider.getTransactionReceipt(txHash);
                if (!receipt) return; // still pending

                if (receipt.status !== 1) {
                    await doc.ref.set(
                        {
                            identityMint: {
                                status: "failed",
                                txHash,
                                failedAt: admin.firestore.FieldValue.serverTimestamp(),
                                receiptStatus: receipt.status,
                                blockNumber: receipt.blockNumber,
                            },
                        },
                        { merge: true }
                    );
                    return;
                }

                const userAddress = data?.walletOriginal || doc.id;
                const mintedIdentity = await contract.getUserIdentity(userAddress);
                const hasIdentity = !!mintedIdentity?.[0];
                const tokenId = mintedIdentity?.[1] != null ? String(mintedIdentity[1]) : null;
                const level = mintedIdentity?.[2] != null ? Number(mintedIdentity[2]) : null;
                const chainTimestamp = mintedIdentity?.[3] != null ? String(mintedIdentity[3]) : null;

                await doc.ref.set(
                    {
                        identityMint: {
                            status: hasIdentity ? "minted" : "minted_unverified",
                            txHash,
                            transactionHash: receipt.hash,
                            blockNumber: receipt.blockNumber,
                            tokenId,
                            level,
                            chainTimestamp,
                            mintedAt: admin.firestore.FieldValue.serverTimestamp(),
                        },
                    },
                    { merge: true }
                );
            })
        );
    }
);

/**
 * Unified Moolre callback:
 * - USSD callbacks: responds with {message, reply}
 * - Payment webhooks: verifies `data.secret`, records deposit, submits mint, responds 200 quickly
 */
export const moolreCallback = onRequest(
    {
        region: "us-central1",
        cors: true,
        secrets: [
            RPC_URL,
            MINTER_PRIVATE_KEY,
            MOOLRE_API_USER,
            MOOLRE_PUBLIC_KEY,
            MOOLRE_ACCOUNT_NUMBER,
            MOOLRE_WEBHOOK_SECRET,
            MOOLRE_CAPTURE_SECRET,
            GHSFIAT_CONTRACT_ADDRESS,
        ],
        timeoutSeconds: 60,
    },
    async (req, res) => {
        if (req.method === "GET") {
            res.status(200).json({ status: "healthy", function: "moolreCallback", timestamp: new Date().toISOString() });
            return;
        }
        if (req.method !== "POST") {
            res.status(405).json({ error: "Method not allowed" });
            return;
        }

        const body = req.body || {};
        const isUssd = Boolean(body?.sessionId || body?.sessionid || body?.msisdn || body?.extension);

        if (isUssd) {
            const sessionId = String(body.sessionId || body.sessionid || "").trim();
            const msisdnRaw = String(body.msisdn || "").trim();
            const msisdn = normalizeMoolreMsisdn(msisdnRaw);
            const network = typeof body.network === "number" ? body.network : Number(body.network);
            const isNew = String(body.new ?? "").toLowerCase() === "true" ? true : Boolean(body.new);
            const message = String(body.message || "").trim();

            if (!sessionId || !msisdn) {
                res.status(400).json({ message: "Invalid session", reply: false });
                return;
            }

            const session = isNew ? null : await getUssdSession(sessionId);
            const step = String(session?.step || "").trim();

            const amountFromDial = parseAmount(body.data);

            async function startDeposit(amount: number) {
                const user = await findUserByPhone(msisdnRaw);
                if (!user) {
                    res.status(200).json({
                        message: "Phone not registered on Fiatsend. Visit app.fiatsend.network to sign up.",
                        reply: false,
                    });
                    return;
                }

                const channel = mapUssdNetworkToChannel(Number.isFinite(network) ? network : undefined);
                const externalref = `FSDEP_${user.userId}_${Date.now()}`.slice(0, 80);

                const now = admin.firestore.Timestamp.now();
                await db.collection("deposits").doc(externalref).set(
                    {
                        externalref,
                        userId: user.userId,
                        msisdn,
                        amount,
                        channel,
                        status: "pending",
                        createdAt: now,
                        updatedAt: now,
                    },
                    { merge: true }
                );

                let init: any;
                try {
                    init = await initiateMoolrePayment({ payer: msisdn, channel, amount, externalref, sessionid: sessionId });
                } catch (e: any) {
                    await db.collection("deposits").doc(externalref).set(
                        {
                            status: "failed",
                            error: e?.message || "payment_service_unavailable",
                            failedAt: now,
                            updatedAt: now,
                        },
                        { merge: true }
                    );
                    res.status(200).json({ message: "Deposit service is temporarily unavailable. Please try again later.", reply: false });
                    return;
                }

                if (isOtpRequired(init)) {
                    await db.collection("deposits").doc(externalref).set({ status: "otp_required", updatedAt: now }, { merge: true });
                    await setUssdSession(sessionId, { step: "awaiting_otp", externalref, msisdn, network: network ?? null, amount });
                    res.status(200).json({ message: "OTP verification required. Enter the OTP sent to your phone:", reply: true });
                    return;
                }

                if (!init.__httpOk || !looksPromptSent(init)) {
                    await db.collection("deposits").doc(externalref).set(
                        {
                            status: "failed",
                            error: init?.message || "payment_initiation_failed",
                            failedAt: now,
                            updatedAt: now,
                        },
                        { merge: true }
                    );
                    res.status(200).json({ message: "We couldn't start your deposit. Please try again.", reply: false });
                    return;
                }

                await db.collection("deposits").doc(externalref).set({ status: "prompt_sent", updatedAt: now }, { merge: true });
                await setUssdSession(sessionId, { step: "done", externalref });
                res.status(200).json({
                    message: `Deposit GHS ${amount.toFixed(2)} to Fiatsend. Authorize the payment prompt on your phone.`,
                    reply: false,
                });
            }

            if (amountFromDial != null) {
                await setUssdSession(sessionId, { step: "deposit_from_dial", msisdn, network: network ?? null });
                await startDeposit(amountFromDial);
                return;
            }

            if (isNew && !message) {
                await setUssdSession(sessionId, { step: "menu", msisdn, network: network ?? null });
                res.status(200).json({ message: "Welcome to Fiatsend\n1. Deposit\n2. Check Balance", reply: true });
                return;
            }

            if (step === "menu") {
                if (message === "1") {
                    await setUssdSession(sessionId, { step: "awaiting_amount" });
                    res.status(200).json({ message: "Enter amount to deposit (GHS):", reply: true });
                    return;
                }
                if (message === "2") {
                    res.status(200).json({ message: "Please check your balance in the Fiatsend app.", reply: false });
                    return;
                }
                res.status(200).json({ message: "Invalid option.\n1. Deposit\n2. Check Balance", reply: true });
                return;
            }

            if (step === "awaiting_amount") {
                const amt = parseAmount(message);
                if (amt == null) {
                    res.status(200).json({ message: "Invalid amount. Enter amount to deposit (GHS):", reply: true });
                    return;
                }
                await startDeposit(amt);
                return;
            }

            if (step === "awaiting_otp") {
                const externalref = String(session?.externalref || "").trim();
                const amount = Number(session?.amount);
                const channel = mapUssdNetworkToChannel(Number(session?.network));

                if (!externalref || !Number.isFinite(amount) || amount <= 0) {
                    res.status(200).json({ message: "Session expired. Dial again to restart.", reply: false });
                    return;
                }

                const otp = String(message || "").trim();
                if (!otp) {
                    res.status(200).json({ message: "Enter the OTP sent to your phone:", reply: true });
                    return;
                }

                let verify: any;
                try {
                    verify = await initiateMoolrePayment({ payer: msisdn, channel, amount, externalref, otpcode: otp, sessionid: sessionId });
                } catch {
                    res.status(200).json({ message: "Verification failed. Please try again later.", reply: false });
                    return;
                }

                if (isInvalidOtp(verify)) {
                    res.status(200).json({ message: "Invalid OTP. Please try again:", reply: true });
                    return;
                }

                if (isOtpVerified(verify)) {
                    let init: any;
                    try {
                        init = await initiateMoolrePayment({ payer: msisdn, channel, amount, externalref, sessionid: sessionId });
                    } catch (e: any) {
                        const now = admin.firestore.Timestamp.now();
                        await db.collection("deposits").doc(externalref).set(
                            {
                                status: "failed",
                                error: e?.message || "payment_initiation_failed_after_otp",
                                failedAt: now,
                                updatedAt: now,
                            },
                            { merge: true }
                        );
                        res.status(200).json({ message: "We couldn't start your deposit. Please try again later.", reply: false });
                        return;
                    }
                    if (!init.__httpOk || !looksPromptSent(init)) {
                        const now = admin.firestore.Timestamp.now();
                        await db.collection("deposits").doc(externalref).set(
                            {
                                status: "failed",
                                error: init?.message || "payment_initiation_failed_after_otp",
                                failedAt: now,
                                updatedAt: now,
                            },
                            { merge: true }
                        );
                        res.status(200).json({ message: "We couldn't start your deposit. Please try again later.", reply: false });
                        return;
                    }
                }

                await db.collection("deposits").doc(externalref).set({ status: "prompt_sent", updatedAt: admin.firestore.Timestamp.now() }, { merge: true });
                await setUssdSession(sessionId, { step: "done" });
                res.status(200).json({ message: "Verification successful. Authorize the payment prompt on your phone.", reply: false });
                return;
            }

            await setUssdSession(sessionId, { step: "unknown_state", lastMessage: message || null });
            res.status(200).json({ message: "Session ended. Dial again to start.", reply: false });
            return;
        }

        // Payment webhook
        const rawData = body?.data ?? {};
        let data: any = rawData;
        if (typeof rawData === "string") {
            try {
                data = JSON.parse(rawData);
            } catch {
                data = {};
            }
        }

        // Some integrations send `secret` at root; docs show `data.secret`.
        const gotSecret = String(data?.secret ?? body?.secret ?? "").trim();
        const expectedSecret = String(MOOLRE_WEBHOOK_SECRET.value() || "").trim();
        if (!gotSecret || !expectedSecret || gotSecret !== expectedSecret) {
            // Optional secret capture for cases where the provider secret is unknown.
            // This stores the raw secret in Firestore (not logs). Enable briefly, copy, then disable & delete.
            try {
                const captureEnabled = String(MOOLRE_CAPTURE_SECRET.value() || "").trim().toLowerCase() === "true";
                if (captureEnabled && gotSecret) {
                    const gotHash = shortHash(gotSecret);
                    const docId = `moolre_${gotHash || Date.now()}`.slice(0, 240);
                    const ref = db.collection("debug_moolre_webhook_secrets").doc(docId);
                    await ref.create({
                        kind: "moolre_webhook_secret_capture",
                        gotSecret,
                        gotSecretHash: gotHash,
                        expectedSecretHash: shortHash(expectedSecret),
                        hasDataSecret: Boolean((data || {})?.secret),
                        hasBodySecret: Boolean((body || {})?.secret),
                        dataType: typeof rawData,
                        topKeys: Object.keys(body || {}).slice(0, 50),
                        dataKeys: Object.keys(data || {}).slice(0, 50),
                        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
                    });
                }
            } catch {
                // ignore capture errors (already exists / permissions / etc)
            }

            logger.warn("Moolre webhook unauthorized", {
                dataType: typeof rawData,
                hasData: Boolean(body?.data),
                hasDataSecret: Boolean(data?.secret),
                hasBodySecret: Boolean(body?.secret),
                gotSecretHash: shortHash(gotSecret),
                expectedSecretHash: shortHash(expectedSecret),
                topKeys: Object.keys(body || {}).slice(0, 20),
                dataKeys: Object.keys(data || {}).slice(0, 20),
            });
            res.status(401).json({ success: false, error: "Unauthorized" });
            return;
        }

        const txstatus = data?.txstatus ?? body?.txstatus ?? body?.status ?? data?.status ?? null;
        if (!(txstatus === 1 || txstatus === "1")) {
            res.status(200).json({ success: true, ignored: true });
            return;
        }

        const payer = String(data?.payer ?? body?.payer ?? "").trim();
        const externalref = (data?.externalref ?? body?.externalref ?? null) as string | null;
        const transactionid = (data?.transactionid ?? body?.transactionid ?? null) as string | number | null;
        const thirdpartyref = (data?.thirdpartyref ?? body?.thirdpartyref ?? null) as string | null;
        const money = parseMoney(data?.value ?? data?.amount ?? body?.value ?? body?.amount);

        if (!payer) {
            res.status(400).json({ success: false, error: "Missing payer" });
            return;
        }
        if (!money) {
            res.status(400).json({ success: false, error: "Invalid amount" });
            return;
        }

        const rawText = JSON.stringify(body || {});
        const depositId = stableDepositId(externalref, transactionid, rawText);
        const ref = db.collection("deposits").doc(depositId);
        const now = admin.firestore.Timestamp.now();

        let wallet: string | null = null;
        let userId: string | null = null;

        const parsedUserId = parseUserIdFromExternalRef(externalref);
        if (parsedUserId) {
            userId = String(parsedUserId).toLowerCase();
            const snap = await db.collection("users").doc(userId).get();
            if (snap.exists) {
                const u = snap.data() as any;
                const w = String(u?.walletOriginal || u?.wallet || snap.id || "").trim();
                if (w && ethers.isAddress(w)) wallet = w;
            }
        }
        if (!wallet) {
            const matched = await findUserByPhone(payer);
            wallet = matched?.wallet ?? null;
            userId = matched?.userId ?? userId;
        }

        if (!wallet) {
            await ref.set(
                {
                    externalref: externalref ?? depositId,
                    msisdn: payer,
                    valueCredited: money.amountNum,
                    moolreTransactionId: transactionid != null ? String(transactionid) : null,
                    thirdpartyref: thirdpartyref ?? null,
                    status: "unmatched",
                    createdAt: now,
                    updatedAt: now,
                },
                { merge: true }
            );
            res.status(200).json({ success: true, unmatched: true });
            return;
        }

        const lock = await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const existing = snap.exists ? (snap.data() as any) : null;
            if (existing?.status === "completed") {
                return { proceed: false, status: "completed", txHash: existing?.txHash ?? null };
            }
            if (existing?.status === "mint_submitted" && existing?.txHash) {
                return { proceed: false, status: "mint_submitted", txHash: existing?.txHash ?? null };
            }
            tx.set(
                ref,
                {
                    externalref: externalref ?? depositId,
                    userId: userId ? String(userId).toLowerCase() : null,
                    wallet: wallet.toLowerCase(),
                    msisdn: payer,
                    valueCredited: money.amountNum,
                    ghsfiatMinted: money.amountNum,
                    moolreTransactionId: transactionid != null ? String(transactionid) : null,
                    thirdpartyref: thirdpartyref ?? null,
                    status: "minting",
                    raw: rawText,
                    updatedAt: now,
                    createdAt: existing?.createdAt ?? now,
                },
                { merge: true }
            );
            return { proceed: true };
        });

        if (!lock.proceed) {
            res.status(200).json({ success: true, status: lock.status, txHash: lock.txHash });
            return;
        }

        try {
            const txHash = await submitGhsfiatMint({ wallet, amountStr: money.amountStr });
            await ref.set({ status: "mint_submitted", txHash, mintSubmittedAt: now, updatedAt: now }, { merge: true });
            res.status(200).json({ success: true, mintSubmitted: true, txHash });
        } catch (e: any) {
            const msg = e?.message || "mint_failed";
            logger.error("Mint submission failed", { msg, depositId });
            await ref.set({ status: "mint_failed", error: msg, failedAt: now, updatedAt: now }, { merge: true });
            res.status(200).json({ success: true, mintFailed: true });
        }
    }
);

/**
 * Confirms submitted mint txs and updates deposits to completed.
 */
export const syncDepositMints = onSchedule(
    {
        schedule: "every 2 minutes",
        secrets: [RPC_URL, VONAGE_API_KEY, VONAGE_API_SECRET, VONAGE_SMS_FROM, GHSFIAT_CONTRACT_ADDRESS],
        timeoutSeconds: 300,
    },
    async () => {
        const rpcUrl = RPC_URL.value();
        if (!rpcUrl) return;

        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const tokenAddress = (GHSFIAT_CONTRACT_ADDRESS.value() || "").trim() || DEFAULT_GHSFIAT_ADDRESS;
        const token = new ethers.Contract(tokenAddress, ERC20_BALANCE_ABI, provider);

        const snapshot = await db.collection("deposits").where("status", "==", "mint_submitted").limit(50).get();
        if (snapshot.empty) return;

        await Promise.all(
            snapshot.docs.map(async (doc) => {
                const data = doc.data() as any;
                const txHash = String(data?.txHash || "").trim();
                if (!txHash) return;

                const receipt = await provider.getTransactionReceipt(txHash);
                if (!receipt) return;

                const now = admin.firestore.Timestamp.now();
                if (receipt.status !== 1) {
                    await doc.ref.set(
                        {
                            status: "mint_failed",
                            error: "mint_tx_failed",
                            failedAt: now,
                            updatedAt: now,
                            receiptStatus: receipt.status,
                            blockNumber: receipt.blockNumber,
                        },
                        { merge: true }
                    );
                    return;
                }

                await doc.ref.set(
                    {
                        status: "completed",
                        completedAt: now,
                        updatedAt: now,
                        blockNumber: receipt.blockNumber,
                    },
                    { merge: true }
                );

                // Send deposit success SMS (best-effort, idempotent).
                const msisdn = String((data as any)?.msisdn || "").trim();
                const wallet = String((data as any)?.wallet || "").trim();
                if (msisdn && wallet && ethers.isAddress(wallet)) {
                    try {
                        const balWei = await token.balanceOf(wallet);
                        const bal = Number(ethers.formatUnits(balWei, 18));
                        const balFixed = (Math.round(bal * 100) / 100).toFixed(2);
                        await sendDepositSmsOnce({ depositId: doc.id, to: msisdn, balanceGhs: balFixed });
                    } catch (e: any) {
                        logger.warn("Deposit SMS failed", { depositId: doc.id, err: e?.message || "sms_failed" });
                    }
                }
            })
        );
    }
);

/**
 * validate-mobile (Firebase HTTPS)
 * Replaces the old Appwrite `*.appwrite.run` function.
 *
 * Request: { receiver: "055...", channel: 1|6|7 }
 * Response: { ok: true, data: <moolre_response> }
 */
const validationCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_DURATION_MS = 5 * 60 * 1000;

export const validateMobile = onRequest(
    {
        region: "us-central1",
        cors: true,
        secrets: [MOOLRE_API_USER, MOOLRE_API_KEY, MOOLRE_ACCOUNT_NUMBER],
        timeoutSeconds: 60,
    },
    async (req, res) => {
        if (req.method !== "POST") {
            res.status(405).json({ ok: false, error: "Method not allowed" });
            return;
        }

        let channel: number | null = null;
        try {
            const body = req.body || {};
            let receiver = String(body.receiver || "").replace(/\D/g, "");
            if (receiver && !receiver.startsWith("0")) {
                receiver = `0${receiver}`;
            }
            channel = Number(body.channel);

            if (!receiver || !channel || ![1, 6, 7].includes(channel)) {
                res.status(400).json({ ok: false, error: "Invalid input" });
                return;
            }

            const apiUser = String(MOOLRE_API_USER.value() || "").trim();
            const apiKey = String(MOOLRE_API_KEY.value() || "").trim();
            const accountNumber = String(MOOLRE_ACCOUNT_NUMBER.value() || "").trim() || "752100407030";
            if (!apiUser || !apiKey) {
                res.status(500).json({ ok: false, error: "Server not configured" });
                return;
            }

            const cacheKey = `${receiver}-${channel}`;
            const cached = validationCache.get(cacheKey);
            if (cached && Date.now() - cached.timestamp < CACHE_DURATION_MS) {
                res.status(200).json({ ok: true, data: cached.data, cached: true });
                return;
            }

            const baseTimeoutMs = Number(process.env.MOOLRE_TIMEOUT_MS || "8000");
            const timeoutMs = channel === 6 ? Math.max(baseTimeoutMs, 45000) : baseTimeoutMs;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

            const resp = await fetch("https://api.moolre.com/open/transact/validate", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-API-USER": apiUser,
                    "X-API-KEY": apiKey,
                },
                body: JSON.stringify({
                    type: 1,
                    receiver,
                    channel,
                    currency: "GHS",
                    accountnumber: accountNumber,
                }),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            const responseText = await resp.text();
            let data: any = null;
            try {
                data = responseText ? JSON.parse(responseText) : {};
            } catch {
                res.status(resp.status).json({
                    ok: false,
                    error: `API returned invalid response. Status: ${resp.status}`,
                });
                return;
            }

            if (!resp.ok) {
                res.status(resp.status).json({ ok: false, error: data?.message || "Validation failed" });
                return;
            }

            // Moolre can return HTTP 200 with `status: 0` (e.g. AIN01 Authentication Error).
            // Only treat `status === 1` as success.
            if (!data || data.status !== 1) {
                const code = String(data?.code || "").toUpperCase();
                const msg = String(data?.message || "Validation failed");
                const statusCode = code === "AIN01" ? 401 : 400;
                res.status(statusCode).json({ ok: false, error: msg, code, data });
                return;
            }

            if (data && data.status === 1) {
                validationCache.set(cacheKey, { data, timestamp: Date.now() });
            }

            res.status(200).json({ ok: true, data });
        } catch (err: any) {
            if (err?.name === "AbortError") {
                const isTelecel = channel === 6;
                res.status(408).json({
                    ok: false,
                    error: isTelecel
                        ? "Telecel validation is taking longer than expected. Please try again or use MTN/AirtelTigo."
                        : "Validation service is currently slow. Please try again in a moment.",
                    isTelecelTimeout: isTelecel,
                });
                return;
            }

            logger.error("validateMobile error", { message: err?.message || "unknown" });
            res.status(500).json({ ok: false, error: "Server error" });
        }
    }
);

// Non-custodial Polygon/BSC USDT/USDC deposit indexer (Firestore + fiatsend-main ledger credit)
export {
    nonCustodialDepositIndexer,
    runNonCustodialDepositIndexerNow,
} from "./scheduled/nonCustodialDepositIndexer";

export { convertCustodialStablecoinToGhs } from "./custodial/convertStablecoinToGhs";
