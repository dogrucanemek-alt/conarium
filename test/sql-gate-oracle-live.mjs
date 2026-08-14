#!/usr/bin/env node
/**
 * Live Oracle proof for sql-gate E.
 * Speaks to gvenzl/oracle-free through sqlplus in the container.
 * Local docker password only — not a product secret.
 *
 * Wait is READY-log then sqlplus, up to 10 minutes. Alias must be a
 * legal unquoted Oracle identifier (not _conarium_cap).
 */
import { spawnSync } from 'node:child_process'
import { guardOracleQuery } from '../src/sql-gate/oracle.ts'

const container = process.env.ORACLE_CONTAINER ?? 'conarium-oracle-gate'
const password = process.env.ORACLE_APP_PASSWORD ?? 'Conarium_Gate1'
const policy = {
  allowTables: ['app.customers'],
  denyTables: ['app.secrets'],
  maskColumns: ['*.email'],
  maxRows: 50,
}

function wsl(args) {
  return spawnSync('wsl', ['-e', ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
}

function sqlplus(sql) {
  const r = spawnSync('wsl', [
    '-e', 'docker', 'exec', '-i', container,
    'sqlplus', '-s', `app/${password}@FREEPDB1`,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    input: `${sql}\nEXIT;\n`,
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (r.status !== 0) throw new Error(`sqlplus exit ${r.status}: ${out.trim()}`)
  if (/ORA-\d+|SP2-\d+|ERROR/i.test(out) && !/0 rows/.test(out)) {
    throw new Error(`sqlplus error: ${out.trim()}`)
  }
  return out
}

function waitReady() {
  wsl(['docker', 'start', container])
  const deadline = Date.now() + 10 * 60 * 1000
  let sawReady = false
  while (Date.now() < deadline) {
    const logs = wsl(['docker', 'logs', container])
    const text = `${logs.stdout ?? ''}${logs.stderr ?? ''}`
    if (/DATABASE IS READY TO USE/i.test(text)) sawReady = true
    if (sawReady) {
      const ping = spawnSync('wsl', [
        '-e', 'docker', 'exec', '-i', container,
        'sqlplus', '-s', `app/${password}@FREEPDB1`,
      ], {
        encoding: 'utf8',
        windowsHide: true,
        input: "SET HEADING OFF\nSET PAGESIZE 0\nSET FEEDBACK OFF\nSELECT 3*3*3 FROM dual;\nEXIT;\n",
      })
      const out = `${ping.stdout ?? ''}${ping.stderr ?? ''}`
      if (!/ORA-01109|ORA-01034|ORA-01017/i.test(out) && /(?:^|\n)\s*27\s*(?:\n|$)/.test(out)) {
        return
      }
    }
    spawnSync('wsl', ['-e', 'sleep', '10'], { encoding: 'utf8' })
  }
  throw new Error('Oracle container did not become ready within 10 minutes')
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

waitReady()

sqlplus(`
WHENEVER SQLERROR EXIT SQL.SQLCODE
BEGIN
  EXECUTE IMMEDIATE 'DROP TABLE customers PURGE';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF;
END;
/
BEGIN
  EXECUTE IMMEDIATE 'DROP TABLE secrets PURGE';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF;
END;
/
CREATE TABLE customers (id NUMBER, email VARCHAR2(200));
CREATE TABLE secrets (id NUMBER, email VARCHAR2(200));
INSERT INTO customers SELECT LEVEL, 'user' || LEVEL || '@example.com' FROM dual CONNECT BY LEVEL <= 80;
INSERT INTO secrets VALUES (1, 'secret@example.com');
COMMIT;
`)

const ungated = sqlplus('SELECT COUNT(*) FROM customers;')
assert(/80/.test(ungated), `ungated customers should be 80, got: ${ungated}`)

const guarded = guardOracleQuery('SELECT id FROM app.customers', policy)
assert(/FETCH FIRST 50 ROWS ONLY/i.test(guarded.sql), `missing FETCH FIRST 50: ${guarded.sql}`)
const capped = sqlplus(`SELECT COUNT(*) FROM (${guarded.sql});`)
assert(/50/.test(capped), `gated count should be 50, got: ${capped}\nSQL=${guarded.sql}`)

let secretsDenied = false
try { guardOracleQuery('SELECT id FROM app.secrets', policy) } catch { secretsDenied = true }
assert(secretsDenied, 'app.secrets must be denied by the gate')

let garbageDenied = false
try { guardOracleQuery('not sql at all !!!', policy) } catch { garbageDenied = true }
assert(garbageDenied, 'unparseable Oracle must be denied')

const leak = sqlplus('SELECT COUNT(*) FROM secrets;')
assert(/1/.test(leak), `ungated secrets must exist so deny is not a vacuum: ${leak}`)

console.log('PASS oracle-live')
console.log(`  container ${container}`)
console.log(`  ungated customers 80`)
console.log(`  gated SQL ${guarded.sql}`)
console.log(`  gated rows 50`)
console.log('  secrets denied by gate; ungated row still present')
console.log('  unparseable denied')
