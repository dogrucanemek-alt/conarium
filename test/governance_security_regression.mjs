import assert from 'assert/strict'
import { Governance, PolicyError } from '../dist/governance.js'

function expectPolicyError(fn, pattern) {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof PolicyError, 'expected PolicyError')
    assert.match(err.message, pattern)
    return err
  }
  assert.fail('expected PolicyError')
}

const tests = [
  {
    name: 'P0 allowTables requires schema-qualified match',
    run: () => {
      const barePolicy = new Governance({ allowTables: ['customers'] })
      assert.equal(barePolicy.allowsTable('secret.customers'), false)
      expectPolicyError(
        () => barePolicy.guardQuery('SELECT * FROM secret.customers'),
        /not permitted by policy/
      )

      const scopedPolicy = new Governance({ allowTables: ['public.customers'] })
      assert.equal(scopedPolicy.allowsTable('public.customers'), true)
      assert.equal(scopedPolicy.allowsTable('secret.customers'), false)
    },
  },
  {
    name: 'P0 PII lineage masks transformed output expressions',
    run: () => {
      const gov = new Governance({
        allowTables: ['public.customers'],
        maskColumns: ['*.email', '*.tckn'],
      })

      const cases = [
        {
          sql: "SELECT encode(convert_to(email,'UTF8'),'hex') AS x FROM public.customers",
          row: { x: '706174726f6e407369726b65742e636f6d' },
        },
        {
          sql: 'SELECT tckn::bigint AS x FROM public.customers',
          row: { x: 12345678901 },
        },
        {
          sql: "SELECT regexp_split_to_array(email,'') AS x FROM public.customers",
          row: { x: ['p', 'a', 't', 'r', 'o', 'n'] },
        },
      ]

      for (const item of cases) {
        const guarded = gov.guardQuery(item.sql)
        assert.deepEqual(guarded.metadata.maskedFields, ['x'])
        const redacted = gov.redact(
          { rows: [item.row], rowCount: 1, fields: ['x'], sql: guarded.sql },
          guarded.aliases,
          guarded.metadata
        )
        assert.equal(redacted.rows[0].x, '[MASKED_PII]')
        assert.deepEqual(redacted.governance.maskedFields, ['x'])
        assert.equal(redacted.governance.maskedCount, 1)
      }

      const cteUnion = gov.guardQuery(
        'WITH c AS (SELECT email AS e FROM public.customers) SELECT e FROM c UNION SELECT e FROM c'
      )
      assert.deepEqual(cteUnion.metadata.maskedFields, ['e'])
      const cteRedacted = gov.redact(
        { rows: [{ e: '706174726f6e407369726b65742e636f6d' }], rowCount: 1, fields: ['e'], sql: cteUnion.sql },
        cteUnion.aliases,
        cteUnion.metadata
      )
      assert.equal(cteRedacted.rows[0].e, '[MASKED_PII]')
    },
  },
  {
    name: 'P0 unsafe SQL functions are denied by default',
    run: () => {
      const gov = new Governance({ allowTables: ['public.customers'] })

      expectPolicyError(
        () => gov.guardQuery('SELECT public.leak_secret_customers()'),
        /Function 'public\.leak_secret_customers' is not permitted/
      )
      expectPolicyError(
        () => gov.guardQuery('SELECT * FROM public.get_customer_email(123)'),
        /Function 'public\.get_customer_email' is not permitted/
      )

      assert.doesNotThrow(() => gov.guardQuery('SELECT lower(name) AS name FROM public.customers'))
    },
  },
  {
    name: 'P1 WITH queries receive the row cap on the executable SELECT',
    run: () => {
      const gov = new Governance({ allowTables: ['public.customers'], maxRows: 7 })
      const guarded = gov.guardQuery('WITH c AS (SELECT * FROM public.customers) SELECT * FROM c')
      assert.match(guarded.sql, /select \*\s+from c\s+limit\s+\(?7\)?/i)
      assert.equal(guarded.metadata.appliedRowCap, 7)
    },
  },
  {
    name: 'P1 unqualified table names are rejected',
    run: () => {
      const gov = new Governance()
      assert.equal(gov.allowsTable('customers'), false)
      expectPolicyError(
        () => gov.guardQuery('SELECT * FROM customers'),
        /Unqualified table 'customers' is not permitted/
      )
    },
  },
  {
    name: 'P2 aggregate and serialization dump functions are blocked',
    run: () => {
      const gov = new Governance({ allowTables: ['public.customers'] })
      const blocked = [
        "SELECT json_agg(row_to_json(c)) FROM public.customers c",
        'SELECT array_agg(email) FROM public.customers',
        'SELECT row_to_json(c) FROM public.customers c',
        "SELECT string_agg(email, ',') FROM public.customers",
      ]

      for (const sql of blocked) {
        expectPolicyError(() => gov.guardQuery(sql), /High-risk aggregate\/serialization function/)
      }
    },
  },
  {
    name: 'P2 governance metadata records allowed and denied provenance',
    run: () => {
      const gov = new Governance({
        allowTables: ['public.customers'],
        maskColumns: ['*.email'],
        maxRows: 1,
      })

      const guarded = gov.guardQuery('SELECT lower(email) AS e FROM public.customers')
      const redacted = gov.redact(
        {
          rows: [{ e: 'patron@sirket.com' }, { e: 'cto@sirket.com' }],
          rowCount: 2,
          fields: ['e'],
          sql: guarded.sql,
        },
        guarded.aliases,
        guarded.metadata
      )

      assert.deepEqual(redacted.governance.accessedTables, ['public.customers'])
      assert.deepEqual(redacted.governance.accessedFunctions, ['lower'])
      assert.match(redacted.governance.rewrittenSql ?? '', /limit\s+\(?1\)?/i)
      assert.equal(redacted.governance.appliedRowCap, 1)
      assert.deepEqual(redacted.governance.maskedFields, ['e'])
      assert.equal(redacted.governance.maskedCount, 2)
      assert.equal(redacted.governance.truncated, true)
      assert.equal(redacted.governance.denied, false)

      const denied = expectPolicyError(
        () => gov.guardQuery('SELECT public.leak_secret_customers()'),
        /not permitted/
      )
      assert.equal(denied.metadata?.denied, true)
      assert.equal(denied.metadata?.denyReason, denied.message)
      assert.deepEqual(denied.metadata?.accessedFunctions, ['public.leak_secret_customers'])
    },
  },
]

let failed = 0

for (const test of tests) {
  try {
    test.run()
    console.log(`PASS: ${test.name}`)
  } catch (err) {
    failed++
    console.log(`FAIL: ${test.name}`)
    console.error(err)
  }
}

console.log(`\nSummary: ${tests.length - failed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
