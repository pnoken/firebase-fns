# Fiatsend Appwrite Functions

This repository contains Appwrite functions to handle long-running operations that exceed Vercel's 5-second timeout limit.

## Functions

### 1. validate-mobile
- **Purpose**: Validates mobile numbers using Moolre API
- **Timeout**: 45 seconds for Telecel (vs Vercel's 5 seconds)
- **Features**: Caching, error handling, CORS support

### 2. mint-identity
- **Purpose**: Mints identity NFTs on blockchain
- **Timeout**: 15 minutes (vs Vercel's 5 seconds)
- **Features**: Signature verification, Appwrite DB integration

### 3. moolre-callback (USSD + Payment Webhook)
- **Purpose**: Receives Moolre USSD callbacks and payment webhooks, records deposits, and mints GHSFIAT to the user wallet.
- **Why**: Provider callbacks are more reliable outside the Next.js/Vercel app domain (avoids 429/WAF issues).
- **Behavior**:
  - USSD payloads (`sessionId/msisdn/...`) → returns `{ message, reply }` for the USSD session
  - Payment webhook payloads (`data.txstatus/...`) → verifies `data.secret`, writes `deposits/*`, submits mint tx, returns 200 quickly
- **Collections used**: `users`, `deposits`, `ussd_sessions`

## Quick Start

### Prerequisites
- Node.js 18+
- Appwrite account
- Moolre API credentials (for validate-mobile)
- Blockchain RPC access (for mint-identity)

### Installation

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd fiatsend-appwrite-functions
   ```

2. **Install dependencies for each function:**
   ```bash
   cd validate-mobile && npm install
   cd ../mint-identity && npm install
   ```

### Deployment

#### Option 1: Appwrite CLI (Recommended)

1. **Install Appwrite CLI:**
   ```bash
   npm install -g appwrite-cli
   ```

2. **Login to Appwrite:**
   ```bash
   appwrite login
   ```

3. **Deploy functions:**
   ```bash
   # Deploy validate-mobile
   cd validate-mobile
   appwrite init function
   appwrite deploy function

   # Deploy mint-identity
   cd ../mint-identity
   appwrite init function
   appwrite deploy function
   ```

#### Option 2: Appwrite Console

1. Go to [Appwrite Console](https://cloud.appwrite.io)
2. Create new functions for each folder
3. Upload ZIP files
4. Set environment variables
5. Deploy

## Environment Variables

### validate-mobile function:
- `MOOLRE_API_USER` - Your Moolre API user
- `MOOLRE_API_KEY` - Your Moolre API key
- `MOOLRE_TIMEOUT_MS` - Base timeout in milliseconds (default: 8000)
- `MOOLRE_ACCOUNT_NUMBER` - Account number for Moolre API

### mint-identity function:
- `RPC_URL` - Blockchain RPC endpoint
- `MINTER_PRIVATE_KEY` - Private key for minting transactions
- `APPWRITE_ENDPOINT` - Your Appwrite endpoint
- `APPWRITE_PROJECT_ID` - Your Appwrite project ID
- `APPWRITE_API_KEY` - Your Appwrite API key

### moolre-callback function:
- `MOOLRE_API_USER` - Your Moolre API user
- `MOOLRE_PUBLIC_KEY` - Your Moolre public key (used with `X-API-PUBKEY`)
- `MOOLRE_ACCOUNT_NUMBER` - Your Moolre wallet account number
- `MOOLRE_WEBHOOK_SECRET` - Must match incoming webhook payload `data.secret`
- `RPC_URL` - Chain RPC used for minting
- `MINTER_PRIVATE_KEY` - Private key allowed to mint GHSFIAT
- `GHSFIAT_CONTRACT_ADDRESS` - (Optional) overrides default token address
- `VONAGE_API_KEY` - Vonage API key for SMS (optional)
- `VONAGE_API_SECRET` - Vonage API secret for SMS (optional)
- `VONAGE_SMS_FROM` - Sender name/number (optional; default "Fiatsend")

## API Endpoints

### validate-mobile
This is a **public HTTPS endpoint** (Firebase HTTPS function). After deploy, Firebase gives you:

- `https://us-central1-<your-project-id>.cloudfunctions.net/validateMobile`

Request:

```json
{
  "receiver": "0550937111",
  "channel": 6
}
```

### mint-identity
```

### moolre-callback
This is a **public HTTPS endpoint** (not Appwrite executions). After deploy, Firebase gives you:

- `https://us-central1-<your-project-id>.cloudfunctions.net/moolreCallback`

Paste that into Moolre’s **Callback URL** field.
POST /executions
Content-Type: application/json

{
  "userAddress": "0x1234567890123456789012345678901234567890",
  "phoneNumber": "+233550937111",
  "countryCode": "233",
  "timestamp": 1640995200000,
  "signature": "0x..."
}
```

## Testing

Each function includes a test script:

```bash
# Test validate-mobile
cd validate-mobile
node test.js

# Test mint-identity
cd ../mint-identity
node test.js
```

## Security Features

- ✅ Constants moved to server-side (no sensitive data in frontend)
- ✅ Signature verification for mint-identity
- ✅ Replay protection with timestamps
- ✅ Input validation and sanitization
- ✅ CORS support
- ✅ Error handling and logging

## Benefits

- 🚀 **No More Timeout Errors**: 45 seconds for Telecel, 15 minutes for blockchain
- 💰 **Cost Effective**: Uses your existing Appwrite plan
- ⚡ **Better Performance**: Caching and optimized error handling
- 🔧 **Easy Integration**: Works with your current setup
- 📊 **Built-in Monitoring**: Appwrite function logs and metrics

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is licensed under the MIT License.
