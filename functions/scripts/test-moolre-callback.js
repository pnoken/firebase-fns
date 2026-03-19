/**
 * Simple test runner for the Firebase HTTPS function `moolreCallback`.
 *
 * Usage:
 *   node scripts/test-moolre-callback.js https://us-central1-<project>.cloudfunctions.net/moolreCallback <MOOLRE_WEBHOOK_SECRET>
 */

const endpoint = process.argv[2];
const secret = process.argv[3];

if (!endpoint || !secret) {
  console.log("Usage: node scripts/test-moolre-callback.js <endpoint> <MOOLRE_WEBHOOK_SECRET>");
  process.exit(1);
}

async function main() {
  const payload = {
    status: 1,
    code: "P01",
    message: "Transaction Successful",
    data: {
      txstatus: 1,
      payer: "233200647206",
      terminalid: "077030",
      accountnumber: "752100407030",
      name: "Peter Nortey",
      amount: "100.00",
      value: "100.00",
      transactionid: String(Math.floor(Math.random() * 90000000) + 10000000),
      externalref: `FSDEP_test_${Date.now()}`,
      thirdpartyref: "TESTREF",
      secret,
      ts: new Date().toISOString().replace("T", " ").slice(0, 19),
    },
    go: null,
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Body:", text);
}

main().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});

