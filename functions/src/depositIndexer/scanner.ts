import * as logger from "firebase-functions/logger";
import { ethers } from "ethers";
import * as admin from "firebase-admin";
import {
  CHAIN_TOKEN_CONFIG,
  type DepositIndexerChain,
  getIndexerProvider,
} from "./chains";
import {
  confirmationsFromBlock,
  isDepositConfirmed,
  requiredConfirmationsForChain,
} from "./confirmations";
import {
  ERC20_TRANSFER_TOPIC,
  INITIAL_LOOKBACK_BLOCKS,
  MAX_CHUNKS_PER_RUN,
  MIN_STABLECOIN_DEPOSIT_UNITS,
  SCAN_CHUNK_BLOCKS,
} from "./constants";
import { depositLedgerDocId } from "./ledgerDocId";
import {
  bulkResolveUsersByRecipient,
  DEPOSIT_LEDGER_COLLECTION,
  getLastScannedBlock,
  setLastScannedBlock,
  type DepositLedgerStatus,
} from "./store";

export type ScanBlocksResult = {
  chainKey: DepositIndexerChain;
  fromBlock: number;
  toBlock: number;
  newPendingDeposits: number;
  skippedExisting: number;
};

export type NonCustodialDepositIndexerOptions = {
  /** Inclusive block span for each `getLogs` query (provider-dependent; Alchemy free tier ≤ 10). */
  scanChunkBlocks?: number;
  maxChunksPerRun?: number;
};

export class NonCustodialDepositIndexer {
  private readonly scanChunkBlocks: number;
  private readonly maxChunksPerRun: number;

  constructor(
    private readonly db: admin.firestore.Firestore,
    private readonly rpcUrls: { polygon: string; bsc: string },
    private readonly creditDeposit: (params: {
      userId: string;
      chainKey: DepositIndexerChain;
      tokenSymbol: "USDT" | "USDC";
      amountDecimal: string;
      idempotencyKey: string;
    }) => Promise<{ ok: boolean; error?: string }>,
    opts?: NonCustodialDepositIndexerOptions
  ) {
    const chunk = opts?.scanChunkBlocks ?? SCAN_CHUNK_BLOCKS;
    const runs = opts?.maxChunksPerRun ?? MAX_CHUNKS_PER_RUN;
    this.scanChunkBlocks = Math.max(1, Math.min(Math.floor(chunk), 50_000));
    this.maxChunksPerRun = Math.max(1, Math.min(Math.floor(runs), 500));
  }

  private provider(chainKey: DepositIndexerChain): ethers.JsonRpcProvider {
    const url = chainKey === "polygon" ? this.rpcUrls.polygon : this.rpcUrls.bsc;
    return getIndexerProvider(chainKey, url);
  }

  /**
   * Fetch ERC-20 Transfer logs for USDT/USDC in [startBlock, endBlock] and record new rows in
   * `deposit_ledger` (pending). Idempotent on `deposit_ledger` document id.
   */
  async scanBlocks(
    chainKey: DepositIndexerChain,
    startBlock: number,
    endBlock: number
  ): Promise<ScanBlocksResult> {
    const provider = this.provider(chainKey);
    const cfg = CHAIN_TOKEN_CONFIG[chainKey];
    const tokenAddrs = cfg.tokens.map((t) => t.address);
    const tokenMeta = new Map(
      cfg.tokens.map((t) => [t.address.toLowerCase(), t] as const)
    );
    const latest = await provider.getBlockNumber();
    const requiredConfirmations = requiredConfirmationsForChain(chainKey);

    const logs = await provider.getLogs({
      fromBlock: startBlock,
      toBlock: endBlock,
      address: tokenAddrs,
      topics: [ERC20_TRANSFER_TOPIC],
    });

    type Row = {
      txHash: string;
      logIndex: number;
      toLower: string;
      amount: string;
      tokenSymbol: "USDT" | "USDC";
      blockNumber: number;
    };

    const rows: Row[] = [];
    for (const log of logs) {
      if (!log.topics || log.topics.length < 3) continue;
      const meta = tokenMeta.get(log.address.toLowerCase());
      if (!meta || (meta.symbol !== "USDT" && meta.symbol !== "USDC")) continue;
      const to = ethers.getAddress(ethers.dataSlice(log.topics[2]!, 12));
      const toLower = to.toLowerCase();
      const amountRaw = BigInt(log.data);
      const amount = ethers.formatUnits(amountRaw, meta.decimals);
      const tokenAmount = parseFloat(amount);
      if (!Number.isFinite(tokenAmount) || tokenAmount < MIN_STABLECOIN_DEPOSIT_UNITS) {
        continue;
      }
      rows.push({
        txHash: log.transactionHash,
        logIndex: log.index,
        toLower,
        amount,
        tokenSymbol: meta.symbol,
        blockNumber: log.blockNumber,
      });
    }

    const recipients = rows.map((r) => r.toLower);
    const userByRecipient = await bulkResolveUsersByRecipient(this.db, recipients);

    let newPending = 0;
    let skippedExisting = 0;

    for (const r of rows) {
      const userId = userByRecipient.get(r.toLower);
      if (!userId) continue;

      const docId = depositLedgerDocId(chainKey, r.txHash, r.logIndex);
      const ref = this.db.collection(DEPOSIT_LEDGER_COLLECTION).doc(docId);
      const confirmations = confirmationsFromBlock(r.blockNumber, latest);
      try {
        const outcome = await this.db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (snap.exists) {
            const existing = snap.data() as { status?: string };
            if (existing.status === "confirmed") {
              return "skipped" as const;
            }
            tx.set(
              ref,
              {
                blockNumber: r.blockNumber,
                confirmations,
                requiredConfirmations,
                status: "pending" satisfies DepositLedgerStatus,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
            return "updated" as const;
          }
          tx.set(ref, {
            txHash: r.txHash.toLowerCase(),
            logIndex: r.logIndex,
            userId,
            amount: r.amount,
            tokenSymbol: r.tokenSymbol,
            blockNumber: r.blockNumber,
            chainKey,
            chainId: cfg.chainId,
            status: "pending" satisfies DepositLedgerStatus,
            toAddress: r.toLower,
            confirmations,
            requiredConfirmations,
            detectedAt: admin.firestore.FieldValue.serverTimestamp(),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          return "created" as const;
        });
        if (outcome === "created") newPending += 1;
        else skippedExisting += 1;
      } catch (e) {
        logger.error("deposit_ledger transaction failed", {
          docId,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return {
      chainKey,
      fromBlock: startBlock,
      toBlock: endBlock,
      newPendingDeposits: newPending,
      skippedExisting,
    };
  }

  async runCatchUpForChain(chainKey: DepositIndexerChain): Promise<{
    results: ScanBlocksResult[];
    lastScannedBlock: number;
    rpcError?: string;
  }> {
    const results: ScanBlocksResult[] = [];
    let rpcError: string | undefined;
    let lastScanned = await getLastScannedBlock(this.db, chainKey);

    try {
      const provider = this.provider(chainKey);
      const latest = await provider.getBlockNumber();
      let from =
        lastScanned > 0 ? lastScanned + 1 : Math.max(0, latest - INITIAL_LOOKBACK_BLOCKS);

      if (from > latest) {
        return { results, lastScannedBlock: lastScanned };
      }

      let chunks = 0;
      let advancedTo = lastScanned;
      while (from <= latest && chunks < this.maxChunksPerRun) {
        const to = Math.min(from + this.scanChunkBlocks - 1, latest);
        const r = await this.scanBlocks(chainKey, from, to);
        results.push(r);
        advancedTo = to;
        await setLastScannedBlock(this.db, chainKey, advancedTo);
        lastScanned = advancedTo;
        from = to + 1;
        chunks += 1;
        if (to >= latest) break;
      }
    } catch (e) {
      rpcError = e instanceof Error ? e.message : String(e);
      logger.error("runCatchUpForChain failed", { chainKey, message: rpcError });
    }

    return { results, lastScannedBlock: lastScanned, rpcError };
  }

  /**
   * Refresh confirmation counts for in-flight deposits (detected + pending).
   */
  async updateConfirmationProgressForChain(chainKey: DepositIndexerChain): Promise<{
    updated: number;
    latestBlock: number;
  }> {
    const provider = this.provider(chainKey);
    const latest = await provider.getBlockNumber();
    const requiredConfirmations = requiredConfirmationsForChain(chainKey);

    const [detectedSnap, pendingSnap] = await Promise.all([
      this.db
        .collection(DEPOSIT_LEDGER_COLLECTION)
        .where("chainKey", "==", chainKey)
        .where("status", "==", "detected")
        .limit(250)
        .get(),
      this.db
        .collection(DEPOSIT_LEDGER_COLLECTION)
        .where("chainKey", "==", chainKey)
        .where("status", "==", "pending")
        .limit(250)
        .get(),
    ]);

    const docs = [...detectedSnap.docs, ...pendingSnap.docs];
    let updated = 0;
    let batch = this.db.batch();
    let batchCount = 0;

    const flush = async () => {
      if (batchCount > 0) {
        await batch.commit();
        batch = this.db.batch();
        batchCount = 0;
      }
    };

    for (const doc of docs) {
      const d = doc.data();
      const blockNumber = d.blockNumber as number | undefined;
      if (typeof blockNumber !== "number" || !Number.isFinite(blockNumber)) {
        continue;
      }
      const confirmations = confirmationsFromBlock(blockNumber, latest);
      const nextStatus: DepositLedgerStatus =
        confirmations >= 1 ? "pending" : "detected";
      batch.set(
        doc.ref,
        {
          confirmations,
          requiredConfirmations,
          status: nextStatus,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      updated += 1;
      batchCount += 1;
      if (batchCount >= 400) {
        await flush();
      }
    }

    await flush();

    return { updated, latestBlock: latest };
  }

  /**
   * Promote matured deposits to `confirmed` and credit fiatsend-main ledger.
   */
  async confirmPendingForChain(chainKey: DepositIndexerChain): Promise<{
    credited: number;
    failed: number;
    safeThroughBlock: number;
  }> {
    const provider = this.provider(chainKey);
    const latest = await provider.getBlockNumber();
    const requiredConfirmations = requiredConfirmationsForChain(chainKey);
    const safeThrough = latest - requiredConfirmations;

    const pendingSnap = await this.db
      .collection(DEPOSIT_LEDGER_COLLECTION)
      .where("chainKey", "==", chainKey)
      .where("status", "==", "pending")
      .limit(500)
      .get();

    let credited = 0;
    let failed = 0;

    for (const doc of pendingSnap.docs) {
      const d = doc.data();
      const blockNumber = d.blockNumber as number;
      if (typeof blockNumber !== "number" || !isDepositConfirmed(blockNumber, latest, chainKey)) {
        continue;
      }

      const userId = d.userId as string;
      const amount = String(d.amount ?? "");
      const tokenSymbol = d.tokenSymbol as "USDT" | "USDC";
      const idempotencyKey = doc.id;
      const confirmations = confirmationsFromBlock(blockNumber, latest);

      const credit = await this.creditDeposit({
        userId,
        chainKey,
        tokenSymbol,
        amountDecimal: amount,
        idempotencyKey,
      });

      if (!credit.ok) {
        failed += 1;
        logger.error("creditDeposit failed", { idempotencyKey, error: credit.error });
        continue;
      }

      await doc.ref.set(
        {
          status: "confirmed" satisfies DepositLedgerStatus,
          confirmations,
          requiredConfirmations,
          confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      credited += 1;
    }

    return { credited, failed, safeThroughBlock: safeThrough };
  }

  async runFullCycle(): Promise<unknown> {
    const summary: Record<string, unknown> = {};
    for (const chainKey of ["polygon", "bsc"] as const) {
      const catchUp = await this.runCatchUpForChain(chainKey);
      const progress = await this.updateConfirmationProgressForChain(chainKey);
      const confirm = await this.confirmPendingForChain(chainKey);
      summary[chainKey] = { ...catchUp, progress, confirm };
    }
    return summary;
  }
}
