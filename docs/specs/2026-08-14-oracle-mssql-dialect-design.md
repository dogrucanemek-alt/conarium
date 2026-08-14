# Oracle / MS SQL Server — lehçe tasarımı

**Tarih:** 2026-08-14
**Durum:** tasarım (kod yok). Desteklenmiyor.
**Neden:** TEB Arf. Banka sorusu: *"Oracle veya MS SQL Server connector yol haritanızda var mı?"*
**Bu belgenin iddiası:** yol haritası *nasıl* kurulur. İddia etmediği: lehçe hazır, connector yazılabilir, tarih var.

Bugün güvenlik `pgsql-ast-parser` üstünde duruyor (`Governance.guardQuery` + `PostgresConnector.assertReadOnlySql`). Deny listesi, PII soyağacı, satır tavanı, salt-okunur zorlaması, fail-closed parse — hepsi Postgres AST’sine bağlı. Yeni bir lehçe eklemek “konnektör yazmak” değil; ayrıştırıcı katmanını ikinci kez kurmak. Yanlış yapılırsa güvenlik sessizce delinir.

---

## 1. Ayrıştırıcı stratejisi

Üç seçenek. Kör “hepsini IR’ye taşıyalım” yok.

### A — Lehçe başına ayrı ayrıştırıcı + ayrı guard

Her lehçe kendi parser’ı, kendi `guardQuery` / `analyzeRead` / `applyRowCap` kopyası.

| | |
|--|--|
| maliyet | İlk lehçe: parser seçimi + deny/fonksiyon/satır-tavanı + vektör seti. İkinci lehçe neredeyse aynı eforu tekrarlar. |
| risk | İki kaynak. Postgres’te kapanan bir delik (UNION satır tavanı, tırnaklı tanımlayıcı) diğerinde açık kalır. |
| bugünkü kod | Dokunulmaz. Postgres yolu olduğu gibi kalır. |

Banka “MSSQL de var mı?” diye sorunca ikinci kopya zaten kaçınılmaz görünür. Asıl maliyet kopya değil, **iki deny listesinin bayatlaması**.

### B — Ortak ara temsil (IR), lehçe parser’ları IR üretir

```
SQL metni → lehçe parser → Conarium IR → tek guard / soyağacı / satır tavanı → lehçe yazıcı
```

IR’nin taşıması gerekenler (eksik IR = sessiz delik):

- tek ifade (çok ifade IR’ye hiç girmez — reddedilir)
- okuma kökü (SELECT / CTE / set-op)
- şema.nesne referansları (tırnak + büyük/küçük harf *korunarak*)
- çıktı sütunları ve alias
- çağrılan fonksiyonlar
- satır sınırı düğümü (LIMIT / FETCH / TOP / ROWNUM — semantik, sözdizimi değil)
- yazma / kilit / prosedür çağrısı düğümleri (varsa → deny; IR “yok saymaz”)

| | |
|--|--|
| maliyet | Postgres `analyzeRead` / `inspectFunction` / `applyRowCap` IR üstüne taşınır. İlk lehçe ucuzlaşmaz — *pahalılaşır* (IR + Postgres yeniden yazım + yeni parser). İkinci lehçe ucuzlar. |
| risk | IR kaybı. Parser’ın görüp IR’ye koymadığı bir `OPENROWSET` / `DBMS_XMLGEN` “yok” sayılır ve geçer. Fail-closed kuralı: IR’ye oturmayan her düğüm **deny**. “Bilmediğim = izin” yok. |
| bugünkü kod | Taşınabilir, ama bugünkü `Statement` tipi `pgsql-ast-parser`’a yapışık. IR’siz “biraz soyutla” yetmez. |

### C — Hibrit (önerilen)

1. **Postgres yolu olduğu gibi kalır.** Canlı 0.2.8 yüzeyi ve mevcut vektörler bozulmaz.
2. Yeni lehçe **kendi parser’ı** ile girer. Guard mantığı (allow/deny tablo, maske soyağacı, fonksiyon allow-list, satır tavanı, tek ifade, salt okuma) paylaşılan *kurallar* olarak çıkarılır; AST tipi paylaşılmaz.
3. IR, ikinci lehçe *gerçekten* istendiğinde kurulur — ilk lehçenin vektörleri yeşil olduktan sonra. İlk günde IR yok.

Neden C: bugünkü koruma Postgres’te ölçülmüş. Onu IR’ye taşımak, bankaya “Oracle var” demeden önce kendi ürünümüzü yeniden doğrulamak demek. Hibrit, o riski ilk lehçenin kapısına koymaz.

**Karar (tasarım):** C. A yasak değil ama deny listesi kopyalanmasın diye paylaşılan kural tabloları (yazma token’ları değil — lehçe sözlüğü) şart. B, ikinci lehçeden önce ödenmez.

---

## 2. Lehçe farkları envanteri

Her satır: fark → bugünkü korumanın o lehçede nasıl atlatılacağı. “Atlatılır” = parser Postgres varsayımıyla çalışırsa. Yeni lehçe kendi parser’ı olmadan bağlanırsa bu sütun gerçektir.

### 2.1 Tanımlayıcı tırnaklama ve büyük/küçük harf

| | Postgres (bugün) | Oracle | MS SQL |
|--|--|--|--|
| tırnak | `"Customers"` ≠ `customers` | `"Customers"` ≠ `CUSTOMERS` (unquoted → UPPER) | `[Customers]` / `"Customers"`; unquoted collation’a bağlı |
| bugünkü kod | tırnaklı mixed-case **deny** (`governance.ts` quoted-ident). Unquoted fold lowercase. | | |

**Atlatma.** Oracle unquoted `CUSTOMERS` = `CUSTOMERS`. Allow-list `public.customers` ile eşleşmez diye düşünülür; aslında Oracle’da `HR.CUSTOMERS` ile `hr.customers` aynı nesnedir. Fold yanlış yöndeyse allow-list’e *ait olmayan* tablo biner. Ters hata: meşru tablo deny. Fail-closed tercih: emin değilse deny.

MSSQL `[dbo].[Customers]` ile `dbo.customers` eşleşmesi collation + bracket. Postgres tırnak kuralını MSSQL’e taşımak `] ]` kaçışını görmez: `[secret]]]; DROP TABLE` benzeri bir parça, kaba token taramasında yazma sanılıp deny olabilir (güvenli taraf) *veya* parser yoksa string sanılıp geçer.

### 2.2 Şema / sahip

| | Postgres | Oracle | MS SQL |
|--|--|--|--|
| nitelik | `schema.table` (2 parça, zorunlu) | `user.table` — user **=** schema. `schema.package.proc` 3 parça. Synonym. | `server.db.schema.table` 4 parça. Synonym. |
| bugün | niteliksiz tablo deny. 2 parça beklenir. | | |

**Atlatma.** Oracle `CUSTOMERS` (niteliksiz) oturum kullanıcısının şemasına düşer. Bugünkü kural “niteliksiz = deny” Oracle’da da doğru kalmalı — aksi halde allow-list `HR.CUSTOMERS` iken `CUSTOMERS` geçer. Synonym: `PUBLIC.CUSTOMERS` → `HR.PII`. Parser synonym’i çözmezse soyağacı yanlış nesneye bakar; maske yanlış kolona uygulanır, asıl PII ham gider. İlk sürümde synonym **deny**.

MSSQL 4 parçalı ad: `linked.db.dbo.secrets`. Bugünkü 2-parça normalizasyon `dbo.secrets` görür, linked server’ı düşürür. Linked / 3–4 parça **deny**.

### 2.3 Satır sınırı

| | Postgres | Oracle | MS SQL |
|--|--|--|--|
| sözdizimi | `LIMIT n` (AST’ye yazılır; UNION dış sarmalayıcı) | `FETCH FIRST n ROWS ONLY` (12c+). Eski: `ROWNUM` *filtre*. | `TOP n`. `OFFSET / FETCH`. |
| bugün | `applyRowCap` yalnız `select`/`with`. Küme işlemi sarmalanır. | | |

**Atlatma — Oracle.** `ROWNUM` bir LIMIT düğümü değil, `WHERE` predicate. `WHERE ROWNUM < 10 OR 1=1` veya `WHERE ROWNUM > 0` tavanı yok eder. Dışarıdan `FETCH FIRST` sarmalamak doğru yaklaşım; içerideki `ROWNUM`’u “tavan uygulandı” sanmak yalan. `rowCapApplied: true` yalnız *bizim* eklediğimiz sarmalayıcı için.

**Atlatma — MSSQL.** `TOP 100 PERCENT` tavan değil. `SET ROWCOUNT 0` oturum durumu — tek ifade guard’ı bunu görmez; bağlantı *stateful* ise önceki batch tavanı sıfırlar. İlk sürüm: oturum ayarı yok, tek batch, `ROWCOUNT` / `SET` **deny**. `TOP` ile `FETCH` bir arada hangisinin bağlayıcı olduğu parser’a kalır; emin değilse deny.

### 2.4 Tehlikeli yerleşikler

Bugün: allow-list (`SAFE_BUILTIN_FUNCTIONS`) + dump yasağı (`array_agg`, `json_agg`, `string_agg`, …). Listede yoksa deny.

| lehçe | örnek | atlatma |
|--|--|--|
| Oracle | `XMLAGG`, `DBMS_XMLGEN`, `DBMS_LOB.SUBSTR`, `UTL_HTTP`, `CTX_DOC` | Dump / dışarı sızdırma. Postgres listesi bunları tanımaz; “bilinmeyen fonksiyon = deny” korunursa geçerli. Tanıdık *sanılan* isim (`replace`, `substr`) Oracle’da CLOB’un tamamını döndürebilir. |
| Oracle | `JSON_ARRAYAGG` | `json_agg` yasağının kardeşi. İsim farklıysa allow-list’ten kaçar — bu yüzden allow-list (deny-list değil) şart. |
| MSSQL | `FOR XML PATH`, `FOR JSON AUTO` | SELECT soneki; fonksiyon değil. `inspectFunction` görmez. Ayrı yasak. |
| MSSQL | `OPENROWSET`, `OPENDATASOURCE`, `OPENQUERY` | Linked / dosya okuma. Tablo gibi durur. |
| MSSQL | `STRING_AGG`, `XML PATH` birleşimi | Dump. |
| ikisi | `EXECUTE` / `EXEC` / `CALL` / `BEGIN DBMS_…` | Yazma token taraması `CALL`/`DO` yakalar (Postgres). Oracle `BEGIN … END;` anonymous block, MSSQL `EXEC` — kaba `\bCALL\b` bunları kaçırır. |

Kural: yeni lehçede de **allow-list**. Tanımadığın isim deny. `FOR XML` / `OPENROWSET` gibi fonksiyon-olmayan biçimler ayrı deny.

### 2.5 Çok ifade ve toplu iş

| | Postgres | Oracle | MS SQL |
|--|--|--|--|
| ayırıcı | `;` | `;` + `/` (SQL*Plus) | `;` + `GO` (batch, T-SQL değil) |
| blok | — | `BEGIN … END;` anonymous | `BEGIN … END`, `GO` |

Bugün: `parse()` birden fazla statement → deny. Parser’ın görmediği ayırıcı = tek statement sanılır.

**Atlatma — MSSQL.** `SELECT 1 GO DROP TABLE t` — `GO` satır başında, `;` yok. Postgres parser ya patlar (fail-closed, iyi) ya da `GO`’yu alias/ident sanır (kötü). Kural: `GO` / `BEGIN…END` / `/` **parse öncesi** reddedilir; “parser anlasın” denmez.

**Atlatma — Oracle.** `SELECT 1 FROM dual; BEGIN DELETE FROM t; END;` — ikinci blok. `;` ile bölünürse `ast.length > 1` yakalar *eğer* parser Oracle `;` + `BEGIN` tanırsa. Tanımazsa tek çöp statement veya parse error. Parse error = deny.

### 2.6 Yorum ve string kaçışları

| | Postgres | Oracle | MS SQL |
|--|--|--|--|
| yorum | `--` `/* */` | aynı + `REM` (SQL*Plus) | aynı + nested `/* /* */ */` (sürüme bağlı) |
| string | `'` , `E'…'` , `$$` | `'` , `q'[…]'` alternatif kaçış | `'` , `N'` , `'` kaçışı `''` |
| bracket | — | — | `[…]` tanımlayıcı |

Bugün kaba yazma taraması (`WRITE_TOKENS` büyük harf, sözcük sınırı) **yorum/string ayırmaz**. `'DELETE'` bir string içinde `DELETE` token’ı diye deny edebilir (aşırı maske, güvenli taraf). Tersi tehlikeli: `/*` ile kapatılmamış yorum + `*/ SELECT` — parser ve kaba tarama ayrılırsa biri yazar görür biri görmez.

**Atlatma.** Oracle `q'!DELETE!'` kaba taramada `DELETE` görür → deny (güvenli, yanlış pozitif). MSSQL `'/*' + '*/; DROP …'` birleşimi: parser yoksa token tarama birleşik string’i görmez. Bu yüzden kaba tarama *yeterli değil*; parser’ın string/yorum düğümü şart. Parser yoksa metin **geçmez**.

`$$` Postgres’e özgü. Oracle/MSSQL yoluna `$$` gelirse: o lehçenin parser’ı tanımazsa deny (parse fail).

---

## 3. Fail-closed ilkesi

Ayrıştırılamayan sorgu **reddedilir**, asla geçirilmez.

Bu cümle yeni lehçelerde de aynen geçerli. Pazarlık yok.

Somut:

1. Parser exception → `PolicyError` (“Failed to parse SQL”), connector’a gitmez.
2. Parse başarılı ama IR / analiz’e oturmayan düğüm → deny, “yok say” yok.
3. Lehçe belirsiz (Oracle mı MSSQL mı) → deny. Tahmin yok.
4. Niteliksiz / synonym / linked / 3–4 parça / `GO` / `SET` / `ROWNUM` tavanı iddiası — emin değilse deny.
5. Connector, guard’dan geçmemiş metni çalıştırmaz. Bugün `PostgresConnector.assertReadOnlySql` ikinci bir parse. Yeni connector da kendi lehçesinde aynı ikinci kapıyı tutar. Tek kapı = tek hata.

“Parser kütüphanesi SELECT sandı” yetmez. İkinci kapı (connector) aynı ağacı ister; iki parser ayrılırsa **deny** (fail-closed), “birisi kabul etti” değil.

---

## 4. Uygunluk vektörleri planı

`test-vectors/` makbuz doğrulayıcısı içindir. Lehçe vektörleri aynı ruhta olur: dondurulmuş girdi, beklenen karar, üçüncü tarafın bizi çalıştırmadan kontrol edebileceği manifest. Vektörler olmadan lehçe **desteklenmiş sayılmaz**.

Konum önerisi (kod yok; isim rezerv): `test-vectors/dialects/{oracle,mssql}/`.

Her vektör: `{ id, dialect, sql, expect: "deny"|"allow", reason, notes }`. `allow` olanlar için ayrıca `{ capApplied, accessedTables, maskedOutputs }`.

Zorunlu batarya — her lehçe, hepsi yazılmadan “destekleniyor” denmez:

| id sınıfı | neyi dener | beklenen |
|--|--|--|
| `parse-fail` | kırık SQL, kapanmamış string, `q'[` kapanmamış | deny |
| `multi-stmt` | `;` ikinci ifade | deny |
| `batch-go` | `GO` (MSSQL), `/` (Oracle) | deny |
| `write-smuggle` | `DELETE`/`UPDATE`/`INSERT`/`MERGE`/`EXEC`/`CALL`/`BEGIN` | deny |
| `comment-wrap` | `/* DELETE */` meşru SELECT; `'DELETE'` string | deny veya allow — hangisi olduğu *yazılı* ve sabit |
| `quote-ident` | tırnaklı / bracket’li mixed-case | deny (ilk sürüm) veya eşleşme kuralı belgelenmiş |
| `unqualified` | `SELECT * FROM CUSTOMERS` | deny |
| `synonym-or-dblink` | synonym, `OPENQUERY`, `schema.pkg.proc` | deny |
| `rowcap-union` | `A UNION ALL B` tavanın dışında kalmasın | allow + capApplied |
| `rowcap-rownum` | `WHERE ROWNUM < 10 OR 1=1` (Oracle) | deny veya dış sarmalayıcı kanıtı |
| `rowcap-top-percent` | `TOP 100 PERCENT` (MSSQL) | deny veya bizim FETCH sarmalayıcı |
| `dump-fn` | `XMLAGG` / `FOR XML` / `STRING_AGG` / `JSON_ARRAYAGG` | deny |
| `unknown-fn` | listede olmayan fonksiyon | deny |
| `session-state` | `SET ROWCOUNT`, `ALTER SESSION` | deny |
| `pii-lineage` | maskeli kolon alias / alt sorgu / CTE ile kaçış | allow + maskedOutputs dolu; ham kolon çıktıda yok |

Manifest olmadan, yeşil birim test “ben yazdım geçti”dir. Vektör, bankanın güvenlik ekibinin bizi çalıştırmadan koştuğu şeydir.

---

## 5. Aşamalandırma

Tarih yok. Sıra ve büyüklük var.

| sıra | ne | neden | efor (büyüklük) |
|--|--|--|--|
| 0 | bu belge + vektör iskeleti (boş case listesi bile) | “yol haritasında var”ın kanıtı tasarım + vektör planıdır, connector değil | S |
| 1 | **MS SQL Server** önce | Banka / kurumsal TR + EU’da SQL Server payı Oracle’dan sık. TDS + `tedious` / `mssql` olgun. `TOP`/`FETCH` satır tavanı `ROWNUM`’dan düz. 4-parça ad ve `GO` erken kesilir. | L (parser + guard kuralları + vektör bataryası + connector). IR yok. |
| 2 | MSSQL vektörleri yeşil, soyağacı Postgres ile aynı iddiaları taşıyor | İkinci lehçeye geçmeden “MSSQL destekleniyor” denmez | M (asıl iş 1’de) |
| 3 | **Oracle** | `ROWNUM`, synonym, `q'[…]'`, 3-parça paket, SQL*Plus `/`. Parser seçimi daha zor (`node-oracledb` sürücü; SQL parser olarak olgun bir Node AST yok — burası asıl risk). | L+ (parser belirsizliği 1’den büyük) |
| 4 | İkinci lehçe yeşil olduktan sonra IR kararı | İki kopya bayatlamaya başladıysa B’ye geç. Tek lehçede IR ödenmez. | L (Postgres yeniden doğrulama dahil) |

Neden MSSQL önce: (1) `ROWNUM` semantiği tavan yalanına daha yatkın; (2) Node’da T-SQL parser adayı (yine de zayıf) Oracle AST’den daha az boş; (3) banka sorusu ikisini birden soruyor — birini *dürüstçe* “yok, tasarım bu, sıra bu” diye cevaplamak, ikisini yarım vermekten iyi.

Ağır bağımlılık: yeni SQL parser. `pgsql-ast-parser` T-SQL/Oracle konuşmaz. Adaylar tasarımda gerekçelenir, bu turda eklenmez:

- MSSQL: olgun bir T-SQL AST paketi yok. Seçenekler: (a) dar bir recursive-descent (yalnız SELECT/CTE/UNION + TOP/FETCH) — bakım bizim, kapsam bilinçli dar; (b) native/WASM parser — ağır, tedarik zinciri; (c) sunucu-yanı `SET PARSEONLY` / `sys.dm_exec_describe_first_result_set` — ağa güvenir, fail-closed’u veritabanına havale eder, **red**.
- Oracle: aynı (a) dar parser. Resmi SQL AST yok. (c) `EXPLAIN` ile şema çözmek synonym’i *doğru* çözer ama guard’ı DB’ye taşır; ağ düşerse ya açık (yasak) ya kapalı (doğru). Yine **red**.

Öneri: ilk lehçede (a) dar parser, allow-list fonksiyon, vektör bataryası. Genel SQL diyalekti “destekliyoruz” iddiası yok.

---

## 6. Dürüst sınır — bu tasarımla kapanmayanlar

- **Synonym / view / linked server ardındaki gerçek nesne.** Parser metni görür, katalog gerçeğini değil. İlk sürüm bunları deny eder; “çözüp maskele” ayrı bir katalog-bağlama işi ve yanlış çözüm sızıntıdır.
- **Oturum durumu.** `SET`, `ALTER SESSION`, NLS, `ROWCOUNT`, temp table. Tek-ifade + temiz bağlantı varsayımı. Connection pool’da kirli oturum bu belgenin dışında; connector her isteği temiz oturumda açmazsa tavan/maske yalan olur.
- **Stored procedure / fonksiyon gövdesi.** `SELECT fn()` allow-list’teyse gövde `INSERT` içerebilir. Bugün Postgres’te de var. Yeni lehçede prosedür **deny** (çağrı yok).
- **PII soyağacı ifade karmaşası.** `CONCAT` / `||` / `FOR XML` ile parçalanmış TCKN bugün de yarım. Yeni lehçe bunu büyütür, kapatmaz.
- **Parser eksikliği.** Dar parser’ın tanımadığı her sözdizimi deny olur. Banka “bizim rapor SQL’imiz geçmiyor” diyecek. Cevap: genişletme vektörle gelir, “bir kere parse et geçir” ile değil.
- **Şifre / wallet / TNS / Windows auth.** Connector sırrı. Bu belge lehçe güvenliği; kimlik bilgisi rotasyonu Anayasa kilidi.
- **“Oracle destekliyoruz” cümlesi.** Bu belge yayınlansa bile ürün Oracle veya MSSQL konuşmaz. README/site bu turda değişmez.

---

## 7. Bankaya tek cümle

> Bugün yalnız Postgres. Oracle ve MS SQL Server birer connector değil, ikinci bir SQL ayrıştırıcı katmanı. Tasarım yazıldı: fail-closed, vektörsüz lehçe desteklenmiş sayılmaz, sıra önce SQL Server (tavan semantiği daha düz), sonra Oracle. Kod yok; tarih yok.

Bu cümle yeterli değilse bu belge verilir. “Yol haritasında var”ın kanıtı budur.
