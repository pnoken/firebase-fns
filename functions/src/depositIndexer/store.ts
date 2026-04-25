import * as admin from "firebase-admin";

export const WALLETS_COLLECTION = "wallets";
/** Same-address custodial EVM wallets (doc id = userId, field `address` is lowercase). */
export const CUSTODIAL_WALLETS_COLLECTION = "custodial_wallets";
export const DEPOSIT_LEDGER_COLLECTION = "deposit_ledger";
export const SYNC_STATE_COLLECTION = "sync_state";

export type DepositLedgerStatus = "pending" | "confirmed";

export async function getLastScannedBlock(
  db: admin.firestore.Firestore,
  chainKey: string
): Promise<number> {
  const snap = await db.collection(SYNC_STATE_COLLECTION).doc(chainKey).get();
  const v = snap.data()?.lastScannedBlock;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export async function setLastScannedBlock(
  db: admin.firestore.Firestore,
  chainKey: string,
  block: number
): Promise<void> {
  await db.collection(SYNC_STATE_COLLECTION).doc(chainKey).set(
    {
      chainKey,
      lastScannedBlock: block,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/**
 * Resolve many recipient addresses to user ids using:
 * - `wallets.publicAddressLower` (non-custodial / indexed receive address)
 * - `custodial_wallets.address` (same EVM address on Polygon & BSC)
 *
 * Firestore `in` queries allow at most 30 values per query.
 * If an address exists in both collections, `wallets` mapping is kept (should be the same userId).
 */
export async function bulkResolveUsersByRecipient(
  db: admin.firestore.Firestore,
  addressesLower: string[]
): Promise<Map<string, string>> {
  const uniq = [...new Set(addressesLower.map((a) => a.toLowerCase()).filter(Boolean))];
  const out = new Map<string, string>();
  const chunkSize = 30;
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const [walletsSnap, custodialSnap] = await Promise.all([
      db.collection(WALLETS_COLLECTION).where("publicAddressLower", "in", chunk).get(),
      db.collection(CUSTODIAL_WALLETS_COLLECTION).where("address", "in", chunk).get(),
    ]);
    for (const doc of walletsSnap.docs) {
      const lower = doc.data()?.publicAddressLower as string | undefined;
      const uid = doc.id;
      if (lower) {
        out.set(lower, uid);
      }
    }
    for (const doc of custodialSnap.docs) {
      const lower = doc.data()?.address as string | undefined;
      const uid = doc.id;
      if (lower && !out.has(lower)) {
        out.set(lower, uid);
      }
    }
  }
  return out;
}
