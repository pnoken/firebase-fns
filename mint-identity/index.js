const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { ethers } = require("ethers");

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
      { internalType: "enum MobileIdentityNFT.VerificationLevel", name: "level", type: "uint8" },
      { internalType: "uint256", name: "timestamp", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
];

function normalizeCountryCode(countryCode) {
  return countryCode.replace(/^\+/, "").slice(0, 6);
}

function formatMintMessage(userAddress, phoneNumber, countryCode, timestamp) {
  return `Mint identity NFT for ${userAddress}, phone: ${phoneNumber}, cc: ${countryCode}, ts: ${timestamp}`;
}

exports.mintIdentity = onRequest(
  {
    cors: true,
    secrets: [RPC_URL, MINTER_PRIVATE_KEY],
    // You can also set: region, timeoutSeconds, memory, etc.
  },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    let tx;

    try {
      const { userAddress, phoneNumber, countryCode, timestamp, signature } = req.body || {};

      if (!userAddress || !ethers.isAddress(userAddress)) {
        return res.status(400).json({ error: "Invalid user address" });
      }
      if (!phoneNumber || !countryCode || !signature || !timestamp) {
        return res.status(400).json({ error: "Phone number, country code, signature, and timestamp required" });
      }

      // Replay protection
      const now = Date.now();
      const allowedSkew = 2 * 60 * 1000;
      if (Math.abs(now - timestamp) > allowedSkew) {
        return res.status(400).json({ error: "Request expired/stale" });
      }

      // Signature check
      const msg = formatMintMessage(userAddress, phoneNumber, countryCode, timestamp);
      const recovered = ethers.verifyMessage(msg, signature);
      if (recovered.toLowerCase() !== userAddress.toLowerCase()) {
        return res.status(401).json({ error: "Signature address mismatch" });
      }

      const normalizedCountryCode = normalizeCountryCode(countryCode);
      if (!/^\d{1,6}$/.test(normalizedCountryCode)) {
        return res.status(400).json({ error: "Invalid country code format" });
      }

      // Provider + contract
      const provider = new ethers.JsonRpcProvider(RPC_URL.value());
      const minterWallet = new ethers.Wallet(MINTER_PRIVATE_KEY.value(), provider);
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, minterWallet);

      // Already registered?
      let alreadyHasIdentity = false;
      try {
        const [hasIdentity] = await contract.getUserIdentity(userAddress);
        alreadyHasIdentity = !!hasIdentity;
      } catch (_) { }

      if (alreadyHasIdentity) {
        const docId = userAddress.toLowerCase();
        let tokenId = null;
        let level = null;
        let chainTimestamp = null;
        try {
          const identity = await contract.getUserIdentity(userAddress);
          tokenId = identity?.[1] != null ? String(identity[1]) : null;
          level = identity?.[2] != null ? Number(identity[2]) : null;
          chainTimestamp = identity?.[3] != null ? String(identity[3]) : null;
        } catch (_) { }
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
        return res.status(200).json({ success: true, alreadyRegistered: true });
      }

      // Hash phone (privacy note: avoid storing raw phone in DB if possible)
      const phoneHash = ethers.keccak256(ethers.toUtf8Bytes(phoneNumber));

      // Mint
      tx = await contract.mintVerifiedIdentity(userAddress, normalizedCountryCode, phoneHash);

      // Save to Firestore (idempotent: one doc per wallet)
      const docId = userAddress.toLowerCase();
      const userRef = db.collection("users").doc(docId);

      // 1) Record submission immediately (so we don't lose txHash)
      await userRef.set(
        {
          wallet: docId,
          walletOriginal: userAddress,
          // NOTE: plaintext phone is required to show it in Profile (NFT only stores hash).
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
      const receipt = await provider.waitForTransaction(tx.hash, 1, 120000);
      if (!receipt) {
        return res.status(202).json({
          success: true,
          txHash: tx.hash,
          userAddress,
          countryCode: normalizedCountryCode,
          status: "submitted",
          message: "Transaction submitted; awaiting confirmation.",
        });
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
        return res.status(500).json({ error: "Mint transaction failed." });
      }

      let hasIdentity = false;
      let tokenId = null;
      let level = null;
      let chainTimestamp = null;
      try {
        const identity = await contract.getUserIdentity(userAddress);
        hasIdentity = !!identity?.[0];
        tokenId = identity?.[1] != null ? String(identity[1]) : null;
        level = identity?.[2] != null ? Number(identity[2]) : null;
        chainTimestamp = identity?.[3] != null ? String(identity[3]) : null;
      } catch (_) { }

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

      return res.status(200).json({
        success: true,
        txHash: tx.hash,
        userAddress,
        countryCode: normalizedCountryCode,
        message: "Transaction confirmed and saved successfully.",
      });
    } catch (err) {
      return res.status(500).json({ error: err?.message || "Server error during identity minting" });
    }
  }
);
