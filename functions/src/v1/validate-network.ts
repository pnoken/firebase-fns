import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";

// Secrets
const MOOLRE_API_USER = defineSecret("MOOLRE_API_USER");
const MOOLRE_API_KEY = defineSecret("MOOLRE_API_KEY");
const MOOLRE_ACCOUNT_NUMBER = defineSecret("MOOLRE_ACCOUNT_NUMBER");

export const validatePayment = onRequest(
    {
        region: "us-central1", // Explicit region
        cors: true, // Auto-handles CORS preflight & headers
        secrets: [MOOLRE_API_USER, MOOLRE_API_KEY, MOOLRE_ACCOUNT_NUMBER],
        timeoutSeconds: 60, // Ensure we have enough time for Telecel
    },
    async (req, res) => {
        // 1. Method Check (CORS middleware handles OPTIONS, so just check POST)
        if (req.method !== "POST") {
            res.status(405).json({ ok: false, error: "Method not allowed" });
            return;
        }

        logger.info("Processing POST request");

        const body = req.body;
        // logger.info("Request body:", body); // Careful logging PII in production!

        if (!body) {
            res.status(400).json({ ok: false, error: "No request body" });
            return;
        }

        // 2. Validation & Sanitization
        let receiver = (body.receiver || "").replace(/\D/g, "");
        if (receiver.length > 0 && !receiver.startsWith("0")) {
            receiver = `0${receiver}`;
        }
        const channel = Number(body.channel); // Ensure it's a number

        logger.info(`Processing: receiver=${receiver}, channel=${channel}`);

        if (!receiver || !channel || ![1, 6, 7].includes(channel)) {
            res.status(400).json({ ok: false, error: "Invalid input" });
            return;
        }

        // 3. Secrets & Config
        const apiUser = MOOLRE_API_USER.value();
        const apiKey = MOOLRE_API_KEY.value();
        const accountNumber = MOOLRE_ACCOUNT_NUMBER.value() || "752100407030";
        const currency = "GHS";
        const type = 1;

        if (!apiUser || !apiKey) {
            logger.error("Missing API credentials in secrets");
            res.status(500).json({ ok: false, error: "Server not configured" });
            return;
        }

        // 4. Timeout Logic
        // Telecel (6) gets 45s, others get 8s default (configurable via env if needed)
        const baseTimeoutMs = 8000;
        const timeoutMs = channel === 6 ? 45000 : baseTimeoutMs;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            logger.info("Making request to Moolre API");

            const resp = await fetch("https://api.moolre.com/open/transact/validate", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-API-USER": apiUser,
                    "X-API-KEY": apiKey,
                },
                body: JSON.stringify({
                    type,
                    receiver,
                    channel,
                    currency,
                    accountnumber: accountNumber,
                }),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);
            logger.info(`Moolre API response: status=${resp.status}`);

            const responseText = await resp.text();
            let data = null;

            try {
                data = JSON.parse(responseText);
            } catch (parseError) {
                logger.error("Non-JSON response:", responseText.substring(0, 200));
                res.status(resp.status).json({
                    ok: false,
                    error: `API returned invalid response. Status: ${resp.status}`,
                });
                return;
            }

            if (!resp.ok) {
                res.status(resp.status).json({
                    ok: false,
                    error: data?.message || "Validation failed",
                });
                return;
            }

            logger.info("Returning successful response");
            res.status(200).json({ ok: true, data });

        } catch (err: any) {
            clearTimeout(timeoutId);
            logger.error(`Function error: ${err.message}`);

            if (err.name === "AbortError") {
                logger.error("Moolre API timeout");
                const isTelecel = channel === 6;
                const errorMessage = isTelecel
                    ? "Telecel validation is taking longer than expected. Please try again or use MTN/AirtelTigo."
                    : "Validation service is currently slow. Please try again in a moment.";

                res.status(408).json({
                    ok: false,
                    error: errorMessage,
                    isTelecelTimeout: isTelecel,
                });
                return;
            }

            // Check for fetch network errors
            if (err.message && err.message.includes("fetch")) {
                res.status(503).json({ ok: false, error: "Network error" });
                return;
            }

            res.status(500).json({ ok: false, error: "Server error" });
        }
    }
);
