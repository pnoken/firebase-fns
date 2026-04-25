/**
 * Mirrors fiatsend-main custodial_stablecoin_ledger Firestore logic (subset for convert).
 */
import * as admin from "firebase-admin";
import { ethers } from "ethers";

export const CUSTODIAL_STABLECOIN_LEDGER_COLLECTION = "custodial_stablecoin_ledger";
export const LEDGER_DEPOSIT_KEYS_FIELD = "ledgerDepositKeys";

type LedgerChain = "polygon" | "bsc" | "lisk";
type LedgerToken = "USDT" | "USDC";

const TOKEN_DECIMALS: Record<LedgerChain, Record<LedgerToken, number>> = {
  polygon: { USDC: 6, USDT: 6 },
  bsc: { USDC: 18, USDT: 18 },
  lisk: { USDC: 6, USDT: 6 },
};

function getDecimals(chain: LedgerChain, tok: LedgerToken): number | null {
  return TOKEN_DECIMALS[chain]?.[tok] ?? null;
}

function bucket(chain: LedgerChain, token: LedgerToken): string {
  return `${chain}_${token}`;
}

function parseDecimalToRaw(amountDecimal: string, decimals: number): bigint {
  return ethers.parseUnits(amountDecimal.trim(), decimals);
}

export function formatLedgerRaw(rawStr: string, decimals: number): string {
  const s = ethers.formatUnits(BigInt(rawStr || "0"), decimals);
  const n = parseFloat(s);
  return Number.isFinite(n) ? n.toString() : s;
}

function rawToCanonical18(raw: bigint, tokenDecimals: number): bigint {
  const d = BigInt(tokenDecimals);
  const eighteen = BigInt(18);
  if (d === eighteen) return raw;
  if (d < eighteen) return raw * BigInt(10) ** (eighteen - d);
  return raw / BigInt(10) ** (d - eighteen);
}

const UNIFIED_DEBIT_CHAIN_ORDER: LedgerChain[] = ["lisk", "polygon", "bsc"];

export async function debitUnifiedLedgerForAmount(
  db: admin.firestore.Firestore,
  userId: string,
  tokenSymbol: LedgerToken,
  amountDecimal: string
): Promise<{ chainKey: LedgerChain; amountDecimal: string }[]> {
  const recvChain: LedgerChain = "lisk";
  const recvDec = getDecimals(recvChain, tokenSymbol);
  if (recvDec == null) throw new Error(`Unknown ${tokenSymbol} on ${recvChain}`);

  let creditRaw: bigint;
  try {
    creditRaw = parseDecimalToRaw(amountDecimal, recvDec);
  } catch {
    throw new Error("Invalid amount");
  }
  if (creditRaw <= BigInt(0)) throw new Error("Amount must be positive");

  let remaining: bigint;
  try {
    remaining = rawToCanonical18(creditRaw, recvDec);
  } catch {
    throw new Error("Invalid amount");
  }

  const ref = db.collection(CUSTODIAL_STABLECOIN_LEDGER_COLLECTION).doc(userId);
  const takes: { chainKey: LedgerChain; takeRaw: bigint; dec: number }[] = [];

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    let prev = { ...((snap.data()?.balances as Record<string, string> | undefined) || {}) };
    let rem = remaining;

    for (const chainKey of UNIFIED_DEBIT_CHAIN_ORDER) {
      const dec = getDecimals(chainKey, tokenSymbol);
      if (dec == null) continue;
      const k = bucket(chainKey, tokenSymbol);
      const availRaw = BigInt(prev[k] || "0");
      if (availRaw === BigInt(0) || rem === BigInt(0)) continue;

      const factor = dec === 18 ? BigInt(1) : BigInt(10) ** BigInt(18 - dec);
      const maxTakeRaw = dec === 18 ? rem : rem / factor;
      const takeRaw = availRaw < maxTakeRaw ? availRaw : maxTakeRaw;
      if (takeRaw === BigInt(0)) continue;
      const actualCanon = dec === 18 ? takeRaw : takeRaw * factor;
      prev = { ...prev, [k]: (availRaw - takeRaw).toString() };
      rem -= actualCanon;
      takes.push({ chainKey, takeRaw, dec });
    }

    if (rem > BigInt(0)) {
      throw new Error(
        `Insufficient ledger ${tokenSymbol}: need ${formatLedgerRaw(creditRaw.toString(), recvDec)} unified across networks`
      );
    }

    tx.set(
      ref,
      {
        userId,
        balances: prev,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });

  return takes.map((t) => ({
    chainKey: t.chainKey,
    amountDecimal: formatLedgerRaw(t.takeRaw.toString(), t.dec),
  }));
}

export type CreditLedgerResult = { applied: true } | { applied: false; reason: "duplicate_idempotency_key" };

export async function creditLedger(
  db: admin.firestore.Firestore,
  userId: string,
  chainKey: LedgerChain,
  tokenSymbol: LedgerToken,
  amountDecimal: string,
  options?: { idempotencyKey?: string }
): Promise<CreditLedgerResult> {
  const dec = getDecimals(chainKey, tokenSymbol);
  if (dec == null) throw new Error(`Unknown ${tokenSymbol} on ${chainKey}`);
  const delta = parseDecimalToRaw(amountDecimal, dec);
  if (delta <= BigInt(0)) return { applied: true };
  const k = bucket(chainKey, tokenSymbol);
  const idem = options?.idempotencyKey?.trim();
  const ref = db.collection(CUSTODIAL_STABLECOIN_LEDGER_COLLECTION).doc(userId);
  let duplicate = false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.data()?.balances as Record<string, string> | undefined;
    const keyMap = (snap.data()?.[LEDGER_DEPOSIT_KEYS_FIELD] as Record<string, boolean> | undefined) || {};
    if (idem && keyMap[idem] === true) {
      duplicate = true;
      tx.set(
        ref,
        { userId, [LEDGER_DEPOSIT_KEYS_FIELD]: keyMap, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      return;
    }
    const cur = BigInt(prev?.[k] || "0");
    const next = (cur + delta).toString();
    const balances = { ...(prev || {}), [k]: next };
    const ledgerDepositKeys = idem ? { ...keyMap, [idem]: true } : keyMap;
    tx.set(
      ref,
      {
        userId,
        balances,
        [LEDGER_DEPOSIT_KEYS_FIELD]: ledgerDepositKeys,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
  if (duplicate) {
    return { applied: false, reason: "duplicate_idempotency_key" };
  }
  return { applied: true };
}
