import { ethers } from "ethers";

export const DEPOSIT_INDEXER_CHAINS = ["polygon", "bsc"] as const;
export type DepositIndexerChain = (typeof DEPOSIT_INDEXER_CHAINS)[number];

/** Mirrors fiatsend-main `src/lib/multi-chain.ts` defaults for USDT/USDC. */
export const CHAIN_TOKEN_CONFIG: Record<
  DepositIndexerChain,
  { chainId: number; tokens: { symbol: "USDT" | "USDC"; address: string; decimals: number }[] }
> = {
  polygon: {
    chainId: 137,
    tokens: [
      { symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
      { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
    ],
  },
  bsc: {
    chainId: 56,
    tokens: [
      { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
      { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
    ],
  },
};

const providerCache = new Map<string, ethers.JsonRpcProvider>();

export function getIndexerProvider(
  chainKey: DepositIndexerChain,
  rpcUrl: string
): ethers.JsonRpcProvider {
  const key = `${chainKey}:${rpcUrl}`;
  if (providerCache.has(key)) {
    return providerCache.get(key)!;
  }
  const p = new ethers.JsonRpcProvider(rpcUrl);
  providerCache.set(key, p);
  return p;
}
