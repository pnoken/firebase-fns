import type { DepositIndexerChain } from "./chains";
import { REQUIRED_CONFIRMATIONS_BY_CHAIN } from "./constants";

export function requiredConfirmationsForChain(chainKey: DepositIndexerChain): number {
  return REQUIRED_CONFIRMATIONS_BY_CHAIN[chainKey];
}

/** Confirmations counted from mined block through chain tip (inclusive). */
export function confirmationsFromBlock(blockNumber: number, latestBlock: number): number {
  if (!Number.isFinite(blockNumber) || !Number.isFinite(latestBlock) || blockNumber < 0) {
    return 0;
  }
  return Math.max(0, latestBlock - blockNumber + 1);
}

export function isDepositConfirmed(
  blockNumber: number | undefined | null,
  latestBlock: number,
  chainKey: DepositIndexerChain
): boolean {
  if (typeof blockNumber !== "number" || !Number.isFinite(blockNumber)) {
    return false;
  }
  const required = requiredConfirmationsForChain(chainKey);
  return confirmationsFromBlock(blockNumber, latestBlock) >= required;
}
