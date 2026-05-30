export function depositLedgerDocId(chainKey: string, txHash: string, logIndex: number): string {
  return `${chainKey}_${txHash.toLowerCase()}_${logIndex}`;
}
