const { ethers } = require('ethers');
const { Client, Databases, ID } = require('node-appwrite');

// Contract configuration
const CONTRACT_ADDRESS = "0xEB86C28e5767504312926A71eB93Ff1B49De8Db7";
const CONTRACT_ABI = [
  // Include the essential ABI functions for minting
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "user",
        "type": "address"
      },
      {
        "internalType": "string",
        "name": "userCountryCode",
        "type": "string"
      },
      {
        "internalType": "string",
        "name": "hashedPhoneNumber",
        "type": "string"
      }
    ],
    "name": "mintVerifiedIdentity",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "user",
        "type": "address"
      }
    ],
    "name": "getUserIdentity",
    "outputs": [
      {
        "internalType": "bool",
        "name": "hasIdentity",
        "type": "bool"
      },
      {
        "internalType": "uint256",
        "name": "tokenId",
        "type": "uint256"
      },
      {
        "internalType": "enum MobileIdentityNFT.VerificationLevel",
        "name": "level",
        "type": "uint8"
      },
      {
        "internalType": "uint256",
        "name": "timestamp",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
];

// Database configuration
const DB_ID = "68a1595e003bb6e36ad4";
const USERS_COLLECTION_ID = "68a15e650003f7e9cd1f";

function jsonResponse(obj, status = 200) {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj)
  };
}

function normalizeCountryCode(countryCode) {
  return countryCode.replace(/^\+/, "").slice(0, 6);
}

function formatMintMessage(userAddress, phoneNumber, countryCode, timestamp) {
  return `Mint identity NFT for ${userAddress}, phone: ${phoneNumber}, cc: ${countryCode}, ts: ${timestamp}`;
}

module.exports = async ({ req, res, log, error }) => {
  // Enable CORS
  res.headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.send('', 200);
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.json({ error: 'Method not allowed' }, 405);
  }

  let tx;
  let receipt;
  
  try {
    // 1. Parse and validate input
    const { userAddress, phoneNumber, countryCode, timestamp, signature } = req.body;
    
    if (!userAddress || !ethers.isAddress(userAddress)) {
      return res.json({ error: "Invalid user address" }, 400);
    }
    if (!phoneNumber || !countryCode || !signature || !timestamp) {
      return res.json({ error: "Phone number, country code, signature, and timestamp required" }, 400);
    }

    // Check timestamp is recent (replay protection)
    const now = Date.now();
    const allowedSkew = 2 * 60 * 1000; // 2 minutes
    if (Math.abs(now - timestamp) > allowedSkew) {
      return res.json({ error: "Request expired/stale" }, 400);
    }

    // Check signature
    const msg = formatMintMessage(userAddress, phoneNumber, countryCode, timestamp);
    const recovered = ethers.verifyMessage(msg, signature);
    if (recovered.toLowerCase() !== userAddress.toLowerCase()) {
      return res.json({ error: "Signature address mismatch" }, 401);
    }

    // Validate and normalize countryCode
    const normalizedCountryCode = normalizeCountryCode(countryCode);
    if (!/^\d{1,6}$/.test(normalizedCountryCode)) {
      return res.json({ error: "Invalid country code format" }, 400);
    }

    // Setup provider & contract
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const minterWallet = new ethers.Wallet(process.env.MINTER_PRIVATE_KEY, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, minterWallet);

    // Check if already registered
    let alreadyHasIdentity = false;
    try {
      const [hasIdentity] = await contract.getUserIdentity(userAddress);
      if (hasIdentity) alreadyHasIdentity = true;
    } catch (e) {
      log(`Error checking existing identity: ${e.message}`);
    }
    
    if (alreadyHasIdentity) {
      return res.json({ success: true, alreadyRegistered: true }, 200);
    }

    // Privacy-preserving phone hash
    const phoneHash = ethers.keccak256(ethers.toUtf8Bytes(phoneNumber));

    // Mint
    try {
      log(`Attempting to mint identity for ${userAddress}`);
      tx = await contract.mintVerifiedIdentity(userAddress, normalizedCountryCode, phoneHash);
      log(`Transaction submitted: ${tx.hash}`);
      // Don't wait for confirmation to avoid timeout - return immediately
    } catch (mintErr) {
      if (
        mintErr.message?.includes("already registered") ||
        mintErr.message?.includes("AlreadyRegistered")
      ) {
        return res.json({ success: true, alreadyRegistered: true }, 200);
      }
      error(`Minting failed: ${mintErr.message}`);
      return res.json({ error: mintErr.message || "Identity minting failed (onchain)" }, 500);
    }

    // Save to Appwrite DB
    try {
      const client = new Client()
        .setEndpoint(process.env.APPWRITE_ENDPOINT)
        .setProject(process.env.APPWRITE_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);

      const databases = new Databases(client);
      await databases.createDocument(
        DB_ID,
        USERS_COLLECTION_ID,
        ID.unique(),
        {
          wallet: userAddress,
          mobileNumber: phoneNumber,
          countryCode: normalizedCountryCode,
          nftMintTx: tx ? tx.hash : undefined,
          contractAddress: CONTRACT_ADDRESS,
          dateCreated: new Date().toISOString(),
          appwriteUserId: ID.unique(),
          status: "pending", // Will be updated when transaction confirms
        }
      );
      log(`Saved to Appwrite database for ${userAddress}`);
    } catch (dbErr) {
      error(`Appwrite DB save failed: ${dbErr.message || dbErr}`);
      // Don't fail the entire request if DB save fails
    }

    return res.json({
      success: true,
      txHash: tx ? tx.hash : undefined,
      userAddress,
      countryCode: normalizedCountryCode,
      message: "Transaction submitted successfully. Please wait for confirmation."
    }, 200);

  } catch (err) {
    error(`Mint identity error: ${err.message}`);
    
    if (tx) {
      error(`Transaction was submitted but failed: ${tx.hash}`);
    }
    
    return res.json({ 
      error: err.message || "Server error during identity minting" 
    }, 500);
  }
};
