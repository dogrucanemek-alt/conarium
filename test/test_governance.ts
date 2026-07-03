import { ApiGovernance, PolicyError } from '../src/governance.js';
import { executeOpenApiTool } from '../src/executor.js';

// Mock fetch for the executor
const originalFetch = global.fetch;

async function runTests() {
  console.log('--- FAZ 2: GOVERNANCE & EXECUTOR TEST ---');
  
  const policy = {
    maxRows: 2,
    denyTools: ['delete*'],
    allowTools: ['*']
  };

  const governance = new ApiGovernance(policy);

  console.log('\n[TEST 1] Allow/Deny Rules');
  console.log(`- allowsTool('getUsers'): ${governance.allowsTool('getUsers')} (Expected: true)`);
  console.log(`- allowsTool('deleteUser'): ${governance.allowsTool('deleteUser')} (Expected: false)`);

  console.log('\n[TEST 2] PII Masking and Max Rows');
  
  const mockResponse = [
    { id: 1, name: 'Emekcan', email: 'emek@dogrucan.com', phone: '+90 555 123 4567', tckn: '12345678901', card: '1234 5678 1234 5678' },
    { id: 2, name: 'John Doe', email: 'john@doe.com', phone: '123-456-7890', tckn: '10987654321', card: '4321-8765-4321-8765' },
    { id: 3, name: 'Jane Doe', email: 'jane@doe.com', phone: '555-555-5555', tckn: '99999999999', card: '1111222233334444' },
  ];

  console.log('Original Data (3 items):');
  console.log(JSON.stringify(mockResponse, null, 2));

  const redacted = governance.redactResponse(mockResponse);

  console.log('\nRedacted Data (Expected: 2 items, masked PII):');
  console.log(JSON.stringify(redacted, null, 2));

  console.log('\n[TEST 3] Executor wiring (Mock HTTP Request)');
  
  const mockFetch = async (url: string, options: any) => {
    console.log(`[HTTP Mock] Fetching: ${options.method} ${url}`);
    if (options.headers && options.headers['Authorization']) {
      console.log(`[HTTP Mock] Auth Header Present: ${options.headers['Authorization']}`);
    }
    return {
      ok: true,
      headers: new Map([['content-type', 'application/json']]),
      json: async () => mockResponse,
      text: async () => JSON.stringify(mockResponse),
    };
  };

  try {
    const toolName = 'getUsers';
    if (!governance.allowsTool(toolName)) {
      throw new PolicyError(`Tool ${toolName} is denied by policy.`);
    }

    const result = await executeOpenApiTool(
      {
        method: 'GET',
        path: '/users/{tenantId}',
        args: { tenantId: 't123', status: 'active' },
      },
      {
        baseUrl: 'https://api.example.com/v1',
        authHeader: 'Bearer secret_token'
      },
      mockFetch
    );

    const safeResult = governance.redactResponse(result);
    console.log('\nExecutor -> Governance Pipeline Result:');
    console.log(JSON.stringify(safeResult, null, 2));

  } catch (err: any) {
    console.error('Error in pipeline:', err.message);
  } finally {
    global.fetch = originalFetch; // restore
  }
}

runTests().catch(console.error);
