import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";

const VONAGE_API_KEY = defineSecret("VONAGE_API_KEY");
const VONAGE_API_SECRET = defineSecret("VONAGE_API_SECRET");

export const sendVonageOtp = onRequest(
    {
        cors: ["https://app.fiatsend.com", "http://localhost:3000"],
        secrets: [VONAGE_API_KEY, VONAGE_API_SECRET],
    },
    async (req, res) => {
        if (req.method !== "POST") {
            res.status(405).send("Method Not Allowed");
            return;
        }

        const { phoneNumber } = req.body;
        if (!phoneNumber) {
            res.status(400).json({ error: "Phone number required" });
            return;
        }

        const apiKey = VONAGE_API_KEY.value();
        const apiSecret = VONAGE_API_SECRET.value();
        const url = "https://api.nexmo.com/v2/verify";

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")
                },
                body: JSON.stringify({
                    brand: "Fiatsend",
                    workflow: [{ channel: "sms", to: phoneNumber }]
                })
            });

            const data = await response.json();

            if (!response.ok) {
                logger.error("Vonage Error", data);
                res.status(500).json({ error: "Failed to send OTP via Vonage" });
                return;
            }

            res.status(200).json({ requestId: data.request_id });
        } catch (error: any) {
            logger.error("Server Error", error);
            res.status(500).json({ error: "Internal Server Error" });
        }
    }
);

