/**
 * Non-custodial USDT/USDC deposit indexer (Polygon + BSC).
 *
 * Firestore collections:
 * - `wallets` — doc id = userId, fields: publicAddress, publicAddressLower
 * - `custodial_wallets` — doc id = userId, field `address` (lowercase); same EVM address on Polygon/BSC
 * - `deposit_ledger` — doc id = `${chainKey}_${txHash}_${logIndex}`, status pending|confirmed
 * - `sync_state` — doc id = chainKey, field lastScannedBlock
 *
 * Secrets:
 *   firebase functions:secrets:set FIATSEND_MAIN_URL
 *   firebase functions:secrets:set FIATSEND_INTERNAL_SERVICE_SECRET   # same as fiatsend-main INTERNAL_SERVICE_SECRET
 *   firebase functions:secrets:set POLYGON_RPC_URL   # optional
 *   firebase functions:secrets:set BSC_RPC_URL       # optional
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { NonCustodialDepositIndexer } from "../depositIndexer/scanner";
import type { DepositIndexerChain } from "../depositIndexer/chains";
import { creditLedger } from "../custodial/stablecoinLedger";

const FIATSEND_MAIN_URL = defineSecret("FIATSEND_MAIN_URL");
const FIATSEND_INTERNAL_SERVICE_SECRET = defineSecret("FIATSEND_INTERNAL_SERVICE_SECRET");
const POLYGON_RPC_URL = defineSecret("POLYGON_RPC_URL");
const BSC_RPC_URL = defineSecret("BSC_RPC_URL");

function trimBaseUrl(raw: string): string {
  return raw.replace(/\/$/, "");
}

async function creditLedgerOnMain(params: {
  mainUrl: string;
  secret: string;
  userId: string;
  chainKey: DepositIndexerChain;
  tokenSymbol: "USDT" | "USDC";
  amountDecimal: string;
  idempotencyKey: string;
}): Promise<{ ok: boolean; error?: string }> {
  const url = `${trimBaseUrl(params.mainUrl)}/api/internal/service/deposit-indexer/credit-ledger`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.secret}`,
    },
    body: JSON.stringify({
      userId: params.userId,
      chainKey: params.chainKey,
      tokenSymbol: params.tokenSymbol,
      amountDecimal: params.amountDecimal,
      idempotencyKey: params.idempotencyKey,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    return { ok: false, error: `HTTP ${res.status}: ${t.slice(0, 500)}` };
  }
  return { ok: true };
}

function buildIndexer(db: admin.firestore.Firestore): NonCustodialDepositIndexer {
  const mainUrl = (FIATSEND_MAIN_URL.value() || "").trim();
  const secret = (FIATSEND_INTERNAL_SERVICE_SECRET.value() || "").trim();
  const polygon = (POLYGON_RPC_URL.value() || "").trim() || "https://polygon-bor-rpc.publicnode.com";
  const bsc = (BSC_RPC_URL.value() || "").trim() || "https://bsc-dataseed.binance.org";

  return new NonCustodialDepositIndexer(db, { polygon, bsc }, async (p) => {
    try {
      await creditLedger(db, p.userId, p.chainKey, p.tokenSymbol, p.amountDecimal, {
        idempotencyKey: p.idempotencyKey,
      });
    } catch (e: unknown) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "direct_ledger_credit_failed",
      };
    }

    if (mainUrl && secret) {
      const activity = await creditLedgerOnMain({
        mainUrl,
        secret,
        userId: p.userId,
        chainKey: p.chainKey,
        tokenSymbol: p.tokenSymbol,
        amountDecimal: p.amountDecimal,
        idempotencyKey: p.idempotencyKey,
      });
      if (!activity.ok) {
        logger.warn("deposit credited directly; main activity callback failed", {
          idempotencyKey: p.idempotencyKey,
          error: activity.error,
        });
      }
    }

    return { ok: true };
  });
}

/** Every minute — scan new blocks + confirm matured deposits. BSC matures after a few fast blocks. */
export const nonCustodialDepositIndexer = onSchedule(
  {
    schedule: "* * * * *",
    secrets: [
      FIATSEND_MAIN_URL,
      FIATSEND_INTERNAL_SERVICE_SECRET,
      POLYGON_RPC_URL,
      BSC_RPC_URL,
    ],
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async () => {
    const db = admin.firestore();
    try {
      const indexer = buildIndexer(db);
      const summary = await indexer.runFullCycle();
      logger.info("nonCustodialDepositIndexer completed", summary as Record<string, unknown>);
    } catch (e: unknown) {
      logger.error("nonCustodialDepositIndexer failed", {
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
);

/** Manual trigger: GET or POST with Authorization: Bearer <FIATSEND_INTERNAL_SERVICE_SECRET> */
export const runNonCustodialDepositIndexerNow = onRequest(
  {
    secrets: [
      FIATSEND_MAIN_URL,
      FIATSEND_INTERNAL_SERVICE_SECRET,
      POLYGON_RPC_URL,
      BSC_RPC_URL,
    ],
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (req, res) => {
    if (req.method !== "POST" && req.method !== "GET") {
      res.status(405).send("Method not allowed");
      return;
    }
    const auth = String(req.headers.authorization || "");
    const secret = (FIATSEND_INTERNAL_SERVICE_SECRET.value() || "").trim();
    if (!secret || auth !== `Bearer ${secret}`) {
      res.status(401).send("Unauthorized");
      return;
    }
    try {
      const db = admin.firestore();
      const indexer = buildIndexer(db);
      const summary = await indexer.runFullCycle();
      res.status(200).json({ ok: true, summary });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "error";
      res.status(500).json({ ok: false, error: msg });
    }
  }
);
