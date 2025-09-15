// Test script for the Appwrite function
// Run this after deploying to test the function

const fetch = require('node-fetch');

const APPWRITE_FUNCTION_URL = 'https://cloud.appwrite.io/v1/functions/YOUR_FUNCTION_ID/executions';
const APPWRITE_PROJECT_ID = 'YOUR_PROJECT_ID';

async function testValidation() {
  console.log('🧪 Testing Appwrite Function...\n');

  const testCases = [
    {
      name: 'MTN Number',
      data: { receiver: '0550937111', channel: 1 }
    },
    {
      name: 'Telecel Number (Slow)',
      data: { receiver: '0200647206', channel: 6 }
    },
    {
      name: 'AirtelTigo Number',
      data: { receiver: '0271234567', channel: 7 }
    }
  ];

  for (const testCase of testCases) {
    console.log(`📱 Testing ${testCase.name}...`);
    
    try {
      const startTime = Date.now();
      
      const response = await fetch(APPWRITE_FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Appwrite-Project': APPWRITE_PROJECT_ID
        },
        body: JSON.stringify(testCase.data)
      });

      const endTime = Date.now();
      const duration = endTime - startTime;

      const result = await response.json();
      
      console.log(`   ✅ Status: ${response.status}`);
      console.log(`   ⏱️  Duration: ${duration}ms`);
      console.log(`   📊 Result:`, result);
      console.log('');

    } catch (error) {
      console.log(`   ❌ Error: ${error.message}`);
      console.log('');
    }
  }
}

// Run the test
testValidation().catch(console.error);
