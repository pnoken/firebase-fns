import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import { ethers } from "ethers";

admin.initializeApp();
const db = admin.firestore();

// Secrets (set via Firebase CLI)
const RPC_URL = defineSecret("RPC_URL");
const MINTER_PRIVATE_KEY = defineSecret("MINTER_PRIVATE_KEY");

// Contract configuration
const CONTRACT_ADDRESS = "0xEB86C28e5767504312926A71eB93Ff1B49De8Db7";
const CONTRACT_ABI = [
    {
        inputs: [
            { internalType: "address", name: "user", type: "address" },
            { internalType: "string", name: "userCountryCode", type: "string" },
            { internalType: "string", name: "hashedPhoneNumber", type: "string" },
        ],
        name: "mintVerifiedIdentity",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [{ internalType: "address", name: "user", type: "address" }],
        name: "getUserIdentity",
        outputs: [
            { internalType: "bool", name: "hasIdentity", type: "bool" },
            { internalType: "uint256", name: "tokenId", type: "uint256" },
            { internalType: "uint8", name: "level", type: "uint8" },
            { internalType: "uint256", name: "timestamp", type: "uint256" },
        ],
        stateMutability: "view",
        type: "function",
    },
];

function normalizeCountryCode(countryCode: string): string {
    return countryCode.replace(/^\+/, "").slice(0, 6);
}

function formatMintMessage(userAddress: string, phoneNumber: string, countryCode: string, timestamp: number): string {
    return `Mint identity NFT for ${userAddress}, phone: ${phoneNumber}, cc: ${countryCode}, ts: ${timestamp}`;
}

export const mintIdentity = onRequest(
    {
        cors: true,
        secrets: [RPC_URL, MINTER_PRIVATE_KEY],
    },
    async (req, res) => {
        if (req.method !== "POST") {
            res.status(405).json({ error: "Method not allowed" });
            return;
        }

        let tx;

        try {
            const { userAddress, phoneNumber, countryCode, timestamp, signature } = req.body || {};

            if (!userAddress || !ethers.isAddress(userAddress)) {
                res.status(400).json({ error: "Invalid user address" });
                return;
            }
            if (!phoneNumber || !countryCode || !signature || !timestamp) {
                res.status(400).json({ error: "Phone number, country code, signature, and timestamp required" });
                return;
            }

            // Replay protection
            const now = Date.now();
            const allowedSkew = 2 * 60 * 1000;
            if (Math.abs(now - timestamp) > allowedSkew) {
                res.status(400).json({ error: "Request expired/stale" });
                return;
            }

            // Signature check
            const msg = formatMintMessage(userAddress, phoneNumber, countryCode, timestamp);
            const recovered = ethers.verifyMessage(msg, signature);
            if (recovered.toLowerCase() !== userAddress.toLowerCase()) {
                res.status(401).json({ error: "Signature address mismatch" });
                return;
            }

            const normalizedCountryCode = normalizeCountryCode(countryCode);
            if (!/^\d{1,6}$/.test(normalizedCountryCode)) {
                res.status(400).json({ error: "Invalid country code format" });
                return;
            }

            // Provider + contract
            const rpcUrl = RPC_URL.value();
            const privateKey = MINTER_PRIVATE_KEY.value();

            const provider = new ethers.JsonRpcProvider(rpcUrl);
            const minterWallet = new ethers.Wallet(privateKey, provider);
            const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, minterWallet);

            // Already registered?
            let alreadyHasIdentity = false;
            let existingIdentity: any = null;
            try {
                existingIdentity = await contract.getUserIdentity(userAddress);
                // Result is an array-like object or Result object
                alreadyHasIdentity = !!existingIdentity?.[0];
            } catch (_) { }

            if (alreadyHasIdentity) {
                const docId = userAddress.toLowerCase();
                const tokenId = existingIdentity?.[1] != null ? String(existingIdentity[1]) : null;
                const level = existingIdentity?.[2] != null ? Number(existingIdentity[2]) : null;
                const chainTimestamp = existingIdentity?.[3] != null ? String(existingIdentity[3]) : null;

                await db.collection("users").doc(docId).set(
                    {
                        wallet: docId,
                        walletOriginal: userAddress,
                        mobileNumber: phoneNumber,
                        countryCode: normalizedCountryCode,
                        contractAddress: CONTRACT_ADDRESS,
                        dateCreated: new Date().toISOString(),
                        status: "minted",
                        identityMint: {
                            status: "minted",
                            tokenId,
                            level,
                            chainTimestamp,
                            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        },
                    },
                    { merge: true }
                );
                res.status(200).json({ success: true, alreadyRegistered: true });
                return;
            }

            // Hash phone
            const phoneHash = ethers.keccak256(ethers.toUtf8Bytes(phoneNumber));

            // Mint
            tx = await contract.mintVerifiedIdentity(userAddress, normalizedCountryCode, phoneHash);

            // Save to Firestore (idempotent: one doc per wallet)
            const docId = userAddress.toLowerCase();
            const userRef = db.collection("users").doc(docId);

            // 1) Record submission immediately
            await userRef.set(
                {
                    // Keep both for compatibility with existing queries.
                    wallet: docId,
                    walletOriginal: userAddress,
                    mobileNumber: phoneNumber,
                    phoneHash,
                    countryCode: normalizedCountryCode,
                    nftMintTx: tx.hash,
                    contractAddress: CONTRACT_ADDRESS,
                    dateCreated: new Date().toISOString(),
                    status: "submitted",
                    identityMint: {
                        status: "submitted",
                        txHash: tx.hash,
                        submittedAt: admin.firestore.FieldValue.serverTimestamp(),
                    },
                },
                { merge: true }
            );

            // 2) Wait for confirmation and only then mark as minted in DB
            const receipt = await provider.waitForTransaction(tx.hash, 1, 120_000);
            if (!receipt) {
                res.status(202).json({
                    success: true,
                    txHash: tx.hash,
                    userAddress,
                    countryCode: normalizedCountryCode,
                    status: "submitted",
                    message: "Transaction submitted; awaiting confirmation.",
                });
                return;
            }

            if (receipt.status !== 1) {
                await userRef.set(
                    {
                        status: "failed",
                        identityMint: {
                            status: "failed",
                            txHash: tx.hash,
                            failedAt: admin.firestore.FieldValue.serverTimestamp(),
                            receiptStatus: receipt.status,
                            blockNumber: receipt.blockNumber,
                        },
                    },
                    { merge: true }
                );
                res.status(500).json({ error: "Mint transaction failed." });
                return;
            }

            const mintedIdentity = await contract.getUserIdentity(userAddress);
            const hasIdentity = !!mintedIdentity?.[0];
            const tokenId = mintedIdentity?.[1] != null ? String(mintedIdentity[1]) : null;
            const level = mintedIdentity?.[2] != null ? Number(mintedIdentity[2]) : null;
            const chainTimestamp = mintedIdentity?.[3] != null ? String(mintedIdentity[3]) : null;

            await userRef.set(
                {
                    status: hasIdentity ? "minted" : "minted_unverified",
                    identityMint: {
                        status: hasIdentity ? "minted" : "minted_unverified",
                        txHash: tx.hash,
                        transactionHash: receipt.hash,
                        blockNumber: receipt.blockNumber,
                        tokenId,
                        level,
                        chainTimestamp,
                        mintedAt: admin.firestore.FieldValue.serverTimestamp(),
                    },
                },
                { merge: true }
            );

            res.status(200).json({
                success: true,
                txHash: tx.hash,
                userAddress,
                countryCode: normalizedCountryCode,
                message: "Transaction confirmed and saved successfully.",
            });
        } catch (err: any) {
            res.status(500).json({ error: err?.message || "Server error" });
        }
    }
);
