export function normalizeCountryCode(countryCode: string): string {
    return countryCode.replace(/^\+/, "").slice(0, 6);
}

export function formatMintMessage(userAddress: string, phoneNumber: string, countryCode: string, timestamp: number): string {
    return `Mint identity NFT for ${userAddress}, phone: ${phoneNumber}, cc: ${countryCode}, ts: ${timestamp}`;
}
