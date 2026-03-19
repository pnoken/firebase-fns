import { defineSecret } from "firebase-functions/params";

// Define Secrets once
export const RPC_URL = defineSecret("RPC_URL");
export const MINTER_PRIVATE_KEY = defineSecret("MINTER_PRIVATE_KEY");

// Constants
export const CONTRACT_ADDRESS = "0xEB86C28e5767504312926A71eB93Ff1B49De8Db7";
export const CONTRACT_ABI = [
    // ... Paste your ABI array here ...
    {
        inputs: [{ internalType: "address", name: "user", type: "address" }],
        name: "getUserIdentity",
        outputs: [{ internalType: "bool", name: "hasIdentity", type: "bool" }],
        stateMutability: "view",
        type: "function",
    },
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
    }
];
