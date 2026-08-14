# Oracle — bugünkü (Postgres) koruma nasıl atlatılır

Kod yokken, `pgsql-ast-parser` + `WRITE_TOKENS` ile Oracle SQL okunursa.
Bu belge E’den önce yazıldı. Destek iddiası değil.

| Fark | Atlatma (parser Postgres varsayarsa) | Bu turdaki kural |
|---|---|---|
| Tırnak / büyük-küçük | Oracle tırnaksız adı UPPER fold eder. `"secrets"` ≠ `SECRETS`. Postgres tırnak kuralı yanlış eşleşir. | Fold + tırnaklı ad çözülür; niteliksiz **deny**. |
| Şema = kullanıcı | `public.customers` allow-list `APP.CUSTOMERS` ile eşleşmez. | Oracle politikası `app.*`. |
| `ROWNUM` / `FETCH FIRST` | `LIMIT` yok diye tavan sessizce uygulanmaz. `ROWNUM <= 9999` tavan değil. | `FETCH FIRST n ROWS ONLY` n>cap ise cap. `ROWNUM` **deny** (satır tavanı değil, predicate). |
| Analitik / pencere | `ROW_NUMBER() OVER` ile dışarıdan LIMIT taklidi. | Pencere fonksiyonu satır tavanı sayılmaz; dış `FETCH FIRST` zorunlu. |
| `UTL_*` / `DBMS_*` | Fonksiyon allow-list Postgres adları. Ağ/dosya çağrısı geçer gibi durur. | `UTL_` / `DBMS_` **deny** (parse öncesi). |
| `BEGIN…END` | Anonim blok; parser SELECT görmeyebilir veya yutabilir. | SELECT/WITH olmayan **deny**. |
| Yorum / string | `--` `/* */` q-quote `q'!...!'`. | Parse başarısız → **deny**. |
| Synonym | Parser taban tabloyu görmez; allow-list synonym adına bakar. | **Kapanmaz.** Operatör allow-list’e koyduğu adı görür, hedefi değil. LIMITATIONS’ta dürüst kal. |
| DB link `table@dblink` | Uzak tablo yerel gibi durur. | `@` **deny**. |

**Ayrıştırıcı:** `node-sql-parser` 5.4.0’da Oracle build **yok**.
Bunun yerine `@guanmingchiu/sqlparser-ts` 0.62 (`sqlparser-rs` WASM, lehçe `oracle`).
Gerekçe: gerçek Oracle AST. Bakım: genç sarmalayıcı, upstream Apache sqlparser-rs.
`format()` AST→SQL bu sürümde çalışmıyor; satır tavanı orijinal SQL’i `FETCH FIRST n` ile sarar.
Bilmediği girdi **deny**. Synonym hedefi **kapanmaz**.

## Canlı örnek (kabul 2) — 2026-08-14 19:36

İlk tur: `--memory=2g` + init sırasında exec/stop. Log: `CONTAINER: shutdown request received` (SIGTERM). `OOMKilled=false`. Yarım init → `ORA-01109`.
Bu tur: bellek tavanı yok, `--shm-size=1g`, named volume, init bitene kadar dokunulmadı. ~1 dk’da `DATABASE IS READY TO USE` + `APP_USER`. `PASS oracle-live`: 80→50, secrets dolu+deny, garbage deny.
Emit: `_conarium_cap` Oracle’da yasadışı tanımlayıcı (`ORA-00911`); `conarium_cap` oldu.
