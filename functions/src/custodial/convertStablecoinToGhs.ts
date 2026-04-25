import { createHmac, timingSafeEqual } from "node:crypto";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { ethers } from "ethers";
import {
  creditLedger,
  debitUnifiedLedgerForAmount,
} from "./stablecoinLedger";

const FIATSEND_INTERNAL_SERVICE_SECRET = defineSecret("FIATSEND_INTERNAL_SERVICE_SECRET");
/** Same value as fiatsend-main `CONVERT_USER_TOKEN_SECRET` — browser calls this function directly with a signed token. */
const CONVERT_USER_TOKEN_SECRET = defineSecret("CONVERT_USER_TOKEN_SECRET");
const FIATSEND_MAIN_URL = defineSecret("FIATSEND_MAIN_URL");
const RPC_URL = defineSecret("RPC_URL");
const MINTER_PRIVATE_KEY = defineSecret("MINTER_PRIVATE_KEY");
const GHSFIAT_CONTRACT_ADDRESS = defineSecret("GHSFIAT_CONTRACT_ADDRESS");

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

const WALLET_ACTIVITY_COLLECTION = "wallet_activity";
const INBOX = "engagement_inbox";
const CUSTODIAL_WALLETS = "custodial_wallets";

type Asset = "USDT" | "USDC";

const MIN_CONVERT_STABLECOIN_AMOUNT = 2;

function trimBaseUrl(raw: string): string {
  return raw.replace(/\/$/, "");
}

async function getUsdToGhsRate(): Promise<number> {
  try {
    const res = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
    const data = (await res.json()) as { rates?: { GHS?: number } };
    return data.rates?.GHS || 15.0;
  } catch {
    return 15.0;
  }
}

async function mintGhsfiat(params: {
  recipientAddress: string;
  ghsAmount: number;
  rpcUrl: string;
  pk: string;
  tokenAddress: string;
}): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const provider = new ethers.JsonRpcProvider(params.rpcUrl);
    const signer = new ethers.Wallet(params.pk, provider);
    const contract = new ethers.Contract(params.tokenAddress, GHSFIAT_MINT_ABI, signer);
    const amountWei = ethers.parseUnits(params.ghsAmount.toFixed(2), 18);
    const tx = await contract.mint(params.recipientAddress, amountWei);
    const receipt = await tx.wait();
    return { success: true, txHash: receipt?.hash ?? tx.hash };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "mint_failed";
    logger.error("GHSFIAT mint error", { msg });
    return { success: false, error: msg };
  }
}

async function notifyMainActivity(params: {
  mainUrl: string;
  secret: string;
  type: "convert" | "error";
  details: Record<string, string | number | null | undefined>;
}): Promise<void> {
  const url = `${trimBaseUrl(params.mainUrl)}/api/internal/service/notify-activity`;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.secret}`,
      },
      body: JSON.stringify({ type: params.type, details: params.details }),
    });
  } catch (e: unknown) {
    logger.warn("notify-activity failed", { err: e instanceof Error ? e.message : String(e) });
  }
}

async function writeConvertUserFacing(params: {
  db: admin.firestore.Firestore;
  userId: string;
  tokenSymbol: Asset;
  amountStr: string;
  ghsAmount: number;
  mintTxHash: string;
  fxRate: number;
}): Promise<void> {
  const now = admin.firestore.Timestamp.now();
  const dedupeKey = `conv_${params.userId}_${Date.now()}`;

  await params.db.collection(WALLET_ACTIVITY_COLLECTION).add({
    userId: params.userId,
    category: "convert",
    assetSymbol: params.tokenSymbol,
    amount: parseFloat(params.amountStr) || 0,
    secondaryAmount: params.ghsAmount,
    secondaryAsset: "GHSFIAT",
    status: "Completed",
    label: "Converted to GHS",
    createdAt: now,
    meta: {
      mintTxHash: params.mintTxHash,
      fxRate: params.fxRate,
      settlement: "ledger_unified",
      walletActivity: true,
    },
  });

  const inboxRef = params.db
    .collection("users")
    .doc(params.userId)
    .collection(INBOX)
    .doc(dedupeKey.slice(0, 200));
  const snap = await inboxRef.get();
  if (!snap.exists) {
    await inboxRef.set({
      kind: "convert_complete",
      title: `${params.amountStr} ${params.tokenSymbol} → ${params.ghsAmount.toFixed(2)} GHS`,
      body: "Conversion completed. Your GHS balance has been updated.",
      read: false,
      dedupeKey: dedupeKey.slice(0, 200),
      createdAt: now,
    });
  }
}

function parsePostBody(body: unknown): { userId: string; tokenSymbol: Asset; amount: string } | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  /** Must match Firestore `custodial_wallets` document id (same as `users` doc id); do not normalize case. */
  const userId = String(o.userId ?? "").trim();
  const rawSym = String(o.tokenSymbol ?? o.asset ?? "USDT").toUpperCase();
  const tokenSymbol: Asset = rawSym === "USDC" ? "USDC" : "USDT";
  const amount = String(o.amount ?? "").trim();
  if (!userId || !amount) return null;
  if (!/^\d+(\.\d+)?$/.test(amount)) return null;
  return { userId, tokenSymbol, amount };
}

/**
 * `custodial_wallets` keys use the canonical user id; some clients send the same id with different casing.
 * Try exact id first, then lowercase, and use whichever doc has a valid `address`.
 */
function verifyConvertIngressToken(
  token: string,
  ingressSecret: string
): { userId: string; amount: string; tokenSymbol: Asset } | null {
  if (!ingressSecret || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expected = createHmac("sha256", ingressSecret).update(payloadB64).digest("base64url");
  const sigBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const o = parsed as Record<string, unknown>;
  const userId = String(o.u ?? "").trim();
  const amount = String(o.a ?? "").trim();
  const rawSym = String(o.s ?? "USDT").toUpperCase();
  const tokenSymbol: Asset = rawSym === "USDC" ? "USDC" : "USDT";
  const exp = Number(o.exp);
  if (!userId || !amount || !/^\d+(\.\d+)?$/.test(amount)) return null;
  if (!Number.isFinite(exp) || Math.floor(Date.now() / 1000) > exp) return null;
  return { userId, amount, tokenSymbol };
}

async function resolveCustodialWallet(
  db: admin.firestore.Firestore,
  rawUserId: string
): Promise<{ canonicalUserId: string; recipient: string } | null> {
  const trimmed = rawUserId.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const candidates = lower === trimmed ? [trimmed] : [trimmed, lower];
  for (const docId of candidates) {
    const cwSnap = await db.collection(CUSTODIAL_WALLETS).doc(docId).get();
    const recipient = String(cwSnap.data()?.address ?? "").trim();
    if (recipient && ethers.isAddress(recipient)) {
      return { canonicalUserId: docId, recipient };
    }
  }
  return null;
}

export const convertCustodialStablecoinToGhs = onRequest(
  {
    region: "us-central1",
    cors: true,
    secrets: [
      FIATSEND_INTERNAL_SERVICE_SECRET,
      CONVERT_USER_TOKEN_SECRET,
      FIATSEND_MAIN_URL,
      RPC_URL,
      MINTER_PRIVATE_KEY,
      GHSFIAT_CONTRACT_ADDRESS,
    ],
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method not allowed" });
      return;
    }

    const internalSecret = (FIATSEND_INTERNAL_SERVICE_SECRET.value() || "").trim();
    const ingressSecret = (CONVERT_USER_TOKEN_SECRET.value() || "").trim();
    const auth = String(req.headers.authorization || "");
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

    let rawUserId: string;
    let tokenSymbol: Asset;
    let amountStr: string;

    if (internalSecret && bearer === internalSecret) {
      const parsed = parsePostBody(req.body);
      if (!parsed) {
        res.status(400).json({ ok: false, error: "Invalid body (userId, amount, tokenSymbol)" });
        return;
      }
      rawUserId = parsed.userId;
      tokenSymbol = parsed.tokenSymbol;
      amountStr = parsed.amount;
    } else {
      const ing = verifyConvertIngressToken(bearer, ingressSecret);
      if (!ing) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }
      rawUserId = ing.userId;
      tokenSymbol = ing.tokenSymbol;
      amountStr = ing.amount;
    }
    const amountNum = parseFloat(amountStr);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      res.status(400).json({ ok: false, error: "Amount must be positive" });
      return;
    }
    if (amountNum < MIN_CONVERT_STABLECOIN_AMOUNT) {
      res.status(400).json({
        ok: false,
        error: `Minimum conversion is ${MIN_CONVERT_STABLECOIN_AMOUNT} ${tokenSymbol}`,
      });
      return;
    }

    const db = admin.firestore();
    const resolved = await resolveCustodialWallet(db, rawUserId);
    if (!resolved) {
      res.status(400).json({ ok: false, error: "Custodial wallet not found" });
      return;
    }
    const { canonicalUserId: userId, recipient } = resolved;

    const rpcUrl = (RPC_URL.value() || "").trim();
    const pk = (MINTER_PRIVATE_KEY.value() || "").trim();
    const tokenAddress = (GHSFIAT_CONTRACT_ADDRESS.value() || "").trim() || DEFAULT_GHSFIAT_ADDRESS;
    if (!rpcUrl || !pk) {
      res.status(500).json({ ok: false, error: "Mint not configured" });
      return;
    }

    const fx = await getUsdToGhsRate();
    const ghsAmount = Math.round(amountNum * fx * 100) / 100;

    let ledgerSlices: { chainKey: "polygon" | "bsc" | "lisk"; amountDecimal: string }[] = [];
    try {
      ledgerSlices = await debitUnifiedLedgerForAmount(db, userId, tokenSymbol, amountStr);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Insufficient balance";
      res.status(400).json({ ok: false, error: msg, source: "ledger" });
      return;
    }

    const mint = await mintGhsfiat({
      recipientAddress: recipient,
      ghsAmount,
      rpcUrl,
      pk,
      tokenAddress,
    });

    if (!mint.success) {
      try {
        for (const row of ledgerSlices) {
          await creditLedger(db, userId, row.chainKey, tokenSymbol, row.amountDecimal);
        }
      } catch (revertErr: unknown) {
        logger.error("convert: ledger revert after mint failure", {
          err: revertErr instanceof Error ? revertErr.message : String(revertErr),
        });
      }
      const mainUrl = (FIATSEND_MAIN_URL.value() || "").trim();
      if (mainUrl && internalSecret) {
        await notifyMainActivity({
          mainUrl,
          secret: internalSecret,
          type: "error",
          details: {
            kind: "convert_stablecoin_ghs_mint_failed",
            userId,
            tokenSymbol,
            amount: amountStr,
            ghsAmount,
            error: mint.error || "",
          },
        });
      }
      res.status(500).json({
        ok: false,
        error: mint.error || "GHS mint failed — support has been notified",
      });
      return;
    }

    const mainUrl = (FIATSEND_MAIN_URL.value() || "").trim();
    if (mainUrl && internalSecret) {
      await notifyMainActivity({
        mainUrl,
        secret: internalSecret,
        type: "convert",
        details: {
          userId,
          chainKey: "unified",
          tokenSymbol,
          amount: amountStr,
          ghsAmount,
          fxRate: fx,
          tokenPullTxHash: "",
          mintTxHash: mint.txHash || "",
          settlement: "ledger_unified",
        },
      });
    }

    try {
      await writeConvertUserFacing({
        db,
        userId,
        tokenSymbol,
        amountStr,
        ghsAmount,
        mintTxHash: mint.txHash || "",
        fxRate: fx,
      });
    } catch (e: unknown) {
      logger.warn("convert: user-facing activity write failed", {
        err: e instanceof Error ? e.message : String(e),
      });
    }

    res.status(200).json({
      ok: true,
      chainKey: "unified",
      tokenSymbol,
      tokenDebited: amountStr,
      ghsCredited: ghsAmount,
      fxRate: fx,
      mintTxHash: mint.txHash,
      settlement: "ledger_unified",
    });
  }
);
