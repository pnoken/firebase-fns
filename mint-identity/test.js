// Test script for the mint-identity Appwrite function
// Run this after deploying to test the function

const { ethers } = require('ethers');

const APPWRITE_FUNCTION_URL = 'https://cloud.appwrite.io/v1/functions/YOUR_MINT_FUNCTION_ID/executions';
const APPWRITE_PROJECT_ID = 'YOUR_PROJECT_ID';

// Test wallet (you'll need to sign with this wallet)
const TEST_WALLET_PRIVATE_KEY = 'your_test_wallet_private_key';
const TEST_WALLET = new ethers.Wallet(TEST_WALLET_PRIVATE_KEY);

async function testMintIdentity() {
  console.log('🧪 Testing Mint Identity Function...\n');

  try {
    // Create test data
    const userAddress = TEST_WALLET.address;
    const phoneNumber = '+233550937111';
    const countryCode = '233';
    const timestamp = Date.now();
    
    // Create message to sign
    const msg = `Mint identity NFT for ${userAddress}, phone: ${phoneNumber}, cc: ${countryCode}, ts: ${timestamp}`;
    
    // Sign the message
    const signature = await TEST_WALLET.signMessage(msg);
    
    console.log(`📱 Testing mint identity for: ${userAddress}`);
    console.log(`📞 Phone: ${phoneNumber}`);
    console.log(`🌍 Country Code: ${countryCode}`);
    console.log(`⏰ Timestamp: ${timestamp}`);
    console.log(`✍️  Signature: ${signature.substring(0, 20)}...`);
    console.log('');

    const startTime = Date.now();
    
    const response = await fetch(APPWRITE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Appwrite-Project': APPWRITE_PROJECT_ID
      },
      body: JSON.stringify({
        userAddress,
        phoneNumber,
        countryCode,
        timestamp,
        signature
      })
    });

    const endTime = Date.now();
    const duration = endTime - startTime;

    const result = await response.json();
    
    console.log(`✅ Status: ${response.status}`);
    console.log(`⏱️  Duration: ${duration}ms`);
    console.log(`📊 Result:`, result);
    
    if (result.success) {
      console.log(`🎉 Success! Transaction Hash: ${result.txHash || 'N/A'}`);
    } else {
      console.log(`❌ Error: ${result.error}`);
    }

  } catch (error) {
    console.log(`❌ Test Error: ${error.message}`);
  }
}

// Run the test
testMintIdentity().catch(console.error);
