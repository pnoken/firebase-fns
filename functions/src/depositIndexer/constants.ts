import { ethers } from "ethers";

/** Block confirmations before crediting in-app ledger (fiatsend-main). */
export const REQUIRED_CONFIRMATIONS_BY_CHAIN = {
  polygon: 12,
  bsc: 3,
} as const;

/**
 * Blocks per `eth_getLogs` call (inclusive span = this value).
 * Many hosted RPCs cap free tier to **10** blocks (e.g. Alchemy); PAYG or public nodes may allow more — set
 * param `DEPOSIT_INDEXER_GETLOGS_BLOCK_RANGE` on the function (see scheduled handler).
 */
export const SCAN_CHUNK_BLOCKS = 10;

/** Max chunks per scheduled run per chain (with 10-block chunks, 60 ≈ 600 blocks/run/chain). */
export const MAX_CHUNKS_PER_RUN = 60;

/** When `sync_state` is empty, scan this many blocks back from the chain tip. */
export const INITIAL_LOOKBACK_BLOCKS = 2000;

/** Same minimum as fiatsend-main stablecoin deposits (USD). */
export const MIN_STABLECOIN_DEPOSIT_UNITS = 2;

export const ERC20_TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
