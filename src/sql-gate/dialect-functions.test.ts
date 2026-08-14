/**
 * G14 kapıyı MSSQL/Oracle'a taşıdı ama allow-list saf Postgres listesiydi, bu yüzden
 * o lehçelerin en sıradan skaler fonksiyonları (GETDATE, NVL, TO_CHAR…) reddediliyordu:
 * güvenlik açığı kapanırken meşru kullanım kırılmıştı ve takım yeşil olduğu için
 * görünmüyordu — lehçeye özgü fonksiyon koşturan tek test yoktu.
 *
 * Bu dosya iki tarafı BİLE BİLE bir arada tutar: izin verilenler geçmeli, saldırı
 * vektörleri reddedilmeli. Biri diğerini bozarsa aynı dosyada kırmızı görünür.
 */
import { describe, expect, it } from 'vitest'
import { PolicyError } from '../governance.js'
import { guardMssqlQuery } from './mssql.js'
import { guardOracleQuery } from './oracle.js'

const mssqlPolicy = {
  allowTables: ['dbo.customers'],
  denyTables: ['dbo.secrets'],
  maskColumns: ['*.email'],
  maxRows: 50,
}

const oraclePolicy = {
  allowTables: ['app.customers'],
  denyTables: ['app.secrets'],
  maskColumns: ['*.email'],
  maxRows: 50,
}

describe('lehçeye özgü skaler fonksiyonlar geçer', () => {
  it.each([
    ['GETDATE', 'SELECT TOP 10 GETDATE() AS n FROM dbo.customers'],
    ['ISNULL', "SELECT TOP 10 ISNULL(name,'x') AS n FROM dbo.customers"],
    ['DATEADD', 'SELECT TOP 10 DATEADD(day,1,created_at) AS n FROM dbo.customers'],
    ['DATEDIFF', 'SELECT TOP 10 DATEDIFF(day,created_at,created_at) AS n FROM dbo.customers'],
    ['LEN', 'SELECT TOP 10 LEN(name) AS n FROM dbo.customers'],
    ['SUBSTRING', 'SELECT TOP 10 SUBSTRING(name,1,3) AS n FROM dbo.customers'],
  ])('mssql %s', (_label, sql) => {
    expect(() => guardMssqlQuery(sql, mssqlPolicy)).not.toThrow()
  })

  it.each([
    ['NVL', "SELECT NVL(name,'x') AS n FROM app.customers"],
    ['NVL2', "SELECT NVL2(name,'a','b') AS n FROM app.customers"],
    ['TO_CHAR', "SELECT TO_CHAR(created_at,'YYYY') AS n FROM app.customers"],
    ['TO_NUMBER', "SELECT TO_NUMBER('12') AS n FROM app.customers"],
    ['DECODE', "SELECT DECODE(name,'a',1,0) AS n FROM app.customers"],
    ['INSTR', "SELECT INSTR(name,'a') AS n FROM app.customers"],
  ])('oracle %s', (_label, sql) => {
    expect(() => guardOracleQuery(sql, oraclePolicy)).not.toThrow()
  })

  it('ortak allow-list bozulmadı', () => {
    expect(() => guardMssqlQuery('SELECT COUNT(id) AS n FROM dbo.customers', mssqlPolicy)).not.toThrow()
    expect(() => guardOracleQuery('SELECT COUNT(id) AS n FROM app.customers', oraclePolicy)).not.toThrow()
  })
})

describe('G14 saldırı vektörleri HÂLÂ reddediliyor', () => {
  it('satır-toplayan dump fonksiyonları', () => {
    expect(() =>
      guardMssqlQuery("SELECT TOP 50 STRING_AGG(name,'|') AS a FROM dbo.customers", mssqlPolicy),
    ).toThrow(PolicyError)
    expect(() =>
      guardOracleQuery("SELECT LISTAGG(name,'|') AS a FROM app.customers", oraclePolicy),
    ).toThrow(PolicyError)
  })

  it('kullanıcı/paket fonksiyonu', () => {
    expect(() =>
      guardOracleQuery('SELECT app.pkg.dangerous_fn(id) AS a FROM app.customers', oraclePolicy),
    ).toThrow(PolicyError)
  })

  it('lehçe listesi diğer lehçeye sızmıyor', () => {
    // getdate MSSQL'e özgüdür; Oracle kapısında tanınmamalı.
    expect(() => guardOracleQuery('SELECT GETDATE() AS n FROM app.customers', oraclePolicy)).toThrow(
      PolicyError,
    )
    // nvl Oracle'a özgüdür; MSSQL kapısında tanınmamalı.
    expect(() =>
      guardMssqlQuery("SELECT TOP 10 NVL(name,'x') AS n FROM dbo.customers", mssqlPolicy),
    ).toThrow(PolicyError)
  })

  it('OS/dosya/dinamik SQL aileleri kapalı kalıyor', () => {
    expect(() =>
      guardOracleQuery('SELECT DBMS_LOB.SUBSTR(name) AS a FROM app.customers', oraclePolicy),
    ).toThrow(PolicyError)
    expect(() =>
      guardOracleQuery("SELECT UTL_HTTP.REQUEST('http://x') AS a FROM app.customers", oraclePolicy),
    ).toThrow(PolicyError)
  })
})
