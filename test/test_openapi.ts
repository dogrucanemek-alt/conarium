import { generateMcpToolsFromSpec } from '../src/openapi_connector.js';

async function main() {
  const url = 'test/petstore.json';
  console.log(`Loading OpenAPI spec from ${url}...`);
  
  try {
    const tools = await generateMcpToolsFromSpec(url);
    
    console.log(`\nSuccessfully parsed spec. Found ${tools.length} MCP tools.\n`);
    
    console.log('--- List of Tool Names ---');
    for (const t of tools) {
      console.log(`- ${t.name} (${t.description})`);
    }
    
    if (tools.length > 0) {
      console.log('\n--- Example Input Schema for first tool ---');
      console.log(JSON.stringify(tools[0].inputSchema, null, 2));
    }
    
  } catch (err) {
    console.error('Error:', err);
  }
}

main();
