import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { Governance, PolicyError } from '../dist/governance.js'
import { OpenApiConnector } from '../dist/connectors/openapi.js'
import { DocsConnector } from '../dist/connectors/docs.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let passCount = 0
let failCount = 0

const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

// --- GOVERNANCE TESTS ---
test('Governance: maskColumns masks PII', async () => {
  const gov = new Governance({ maskColumns: ['*.email'] })
  const result = gov.redact({
    rows: [{ _table: 'users', name: 'Ahmet', email: 'ahmet@example.com' }],
    rowCount: 1,
    fields: ['name', 'email']
  })
  assert.strictEqual(result.rows[0].name, 'Ahmet', 'Name untouched')
  assert.strictEqual(result.rows[0].email, '[MASKED_PII]', 'Email masked')
})

test('Governance: denyTables hides tables', async () => {
  // default-deny sonrası açık mod explicit (['*']); test niyeti: deny secrets'ı gizler, users kalır
  const gov = new Governance({ allowTables: ['*'], denyTables: ['public.secrets'] })
  const tables = [
    { schema: 'public', name: 'secrets', columns: [] },
    { schema: 'public', name: 'users', columns: [] }
  ]
  const filtered = gov.filterTables(tables)
  assert.strictEqual(filtered.length, 1, 'Should hide one table')
  assert.strictEqual(filtered[0].name, 'users', 'Should keep users table')
})

test('Governance: guardQuery blocks DELETE with PolicyError', async () => {
  const gov = new Governance({})
  assert.throws(() => {
    gov.guardQuery('DELETE FROM users WHERE id=1')
  }, (err) => {
    return err instanceof PolicyError && err.message.includes('Only read-only')
  }, 'Should throw PolicyError blocking DELETE')
})

test('Governance: guardQuery blocks DROP bypass with tabs/newlines', async () => {
  const gov = new Governance({})
  assert.throws(() => {
    gov.guardQuery('SELECT * FROM users;\n\tDROP TABLE users')
  }, (err) => {
    return err instanceof PolicyError && err.message.includes('Blocked write operation: DROP')
  }, 'Should block DROP even with newlines/tabs')
})

test('Governance: guardQuery blocks multi-statement queries', async () => {
  const gov = new Governance({})
  assert.throws(() => {
    gov.guardQuery('SELECT * FROM users; SELECT * FROM other')
  }, (err) => {
    return err instanceof PolicyError && err.message.includes('Multiple statements')
  }, 'Should block multiple statements')
})

// --- OPENAPI TESTS ---
test('OpenApiConnector: stub fetch for listTables and query unknown path', async () => {
  const specPath = path.join(__dirname, 'mock-openapi.json')
  fs.writeFileSync(specPath, JSON.stringify({
    openapi: '3.0.0',
    paths: {
      '/users': {
        get: { summary: 'Get users' }
      }
    }
  }))

  try {
    const connector = new OpenApiConnector({
      type: 'openapi',
      name: 'mock-api',
      description: 'Mock',
      config: { url: specPath }
    })

    await connector.connect()

    // Test listTables
    const tables = await connector.listTables()
    assert.strictEqual(tables.length, 1, 'Should find 1 endpoint')
    assert.strictEqual(tables[0].name, 'GET /users', 'Endpoint name matches')

    // Test query unknown path
    await assert.rejects(
      connector.query('GET /unknown'),
      /endpoint not in spec/i,
      'Should throw endpoint not in spec error'
    )
  } finally {
    fs.rmSync(specPath, { force: true })
  }
})

// --- DOCS TESTS ---
test('DocsConnector: search using mock folder', async () => {
  const mockDir = path.join(__dirname, 'mock_docs')
  if (!fs.existsSync(mockDir)) fs.mkdirSync(mockDir, { recursive: true })
  
  const filePath = path.join(mockDir, 'architecture.md')
  fs.writeFileSync(filePath, '# Mock Title\n\nThis is a mock documentation with keyword: nexus_test_search')

  try {
    const connector = new DocsConnector({
      type: 'docs',
      name: 'mock-docs',
      description: 'Mock',
      config: { path: mockDir }
    })

    await connector.connect()
    
    // Test search
    const result = await connector.search('nexus_test_search')
    assert.strictEqual(result.rowCount, 1, 'Should find 1 result')
    assert.strictEqual(result.rows[0].file, 'architecture.md', 'File name matches')
    assert.ok(result.rows[0].contentSnippet.includes('Mock Title'), 'Snippet matches')
  } finally {
    fs.rmSync(mockDir, { recursive: true, force: true })
  }
})

// --- RUNNER ---
;(async () => {
  for (const t of tests) {
    try {
      await t.fn()
      console.log(`PASS: ${t.name}`)
      passCount++
    } catch (err) {
      console.log(`FAIL: ${t.name}`)
      console.error(err)
      failCount++
    }
  }

  console.log('\n--- Summary ---')
  console.log(`PASS: ${passCount}`)
  console.log(`FAIL: ${failCount}`)

  if (failCount > 0) {
    process.exit(1)
  }
})()
