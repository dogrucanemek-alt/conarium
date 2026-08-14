# MSSQL — bugünkü (Postgres) koruma nasıl atlatılır

Kod yokken, `pgsql-ast-parser` + `WRITE_TOKENS` ile T-SQL okunursa.
Bu belge D’den önce yazıldı. Destek iddiası değil.

| Fark | Atlatma (parser Postgres varsayarsa) | Bu turdaki kural |
|---|---|---|
| Köşeli parantez `[Customers]` | Postgres tırnak kuralı `[` görmez. `[secrets]` string veya bilinmeyen token olabilir. | Parantezli ad çözülür; 3–4 parça ve linked server **deny**. |
| `TOP` vs `LIMIT` | `LIMIT` yok diye satır tavanı sessizce uygulanmaz. `TOP 100 PERCENT` tavan değil. | `TOP 100 PERCENT` **deny**. `TOP n` n>cap ise cap’e çekilir. Yoksa `TOP (cap)` eklenir. |
| Şema / sahip `dbo` | `public.customers` allow-list `dbo.customers` ile eşleşmez (ters hata) veya 4 parça düşer. | MSSQL politikası `dbo.*`. `server.db.schema.table` **deny**. Niteliksiz **deny**. |
| `GO` | Batch ayırıcı; parser tek SELECT görüp gerisini yutabilir. | `\bGO\b` **deny**. |
| `;` çok ifade | İkinci ifade yazma olabilir. | Birden fazla ifade **deny**. |
| `xp_*` / `sp_*` | Fonksiyon allow-list Postgres adları. `xp_cmdshell` geçer gibi durur. | `xp_` / `sp_` **deny** (parse öncesi). |
| `OPENROWSET` / `OPENQUERY` | Tablo gibi durur; `inspectFunction` görmez. | İsim **deny**. |
| `FOR XML` / `FOR JSON` | SELECT soneki, fonksiyon değil. | **deny**. |
| `EXEC` / `EXECUTE` | `\bCALL\b` yakalamaz. | **deny**. |
| Yorum / string | `--` ve `/* */` Postgres ile aynı sınıf; kaçış `]` `]]`. | Parse başarısız → **deny**. |

**Ayrıştırıcı:** `node-sql-parser` (yalnız `transactsql` build).
Gerekçe: T-SQL AST + sqlify. Bakım riski: Microsoft parser’ı değil; PEG. Bilmediği düğüm **deny**, “bilmiyorum = izin” yok.

## Parser’ın kabul edip kapının reddettiği (bu turda bulundu)

Savunma gevşetilmedi. Pre-deny / tip kontrolü şart:

| Girdi | Parser | Kapı |
|---|---|---|
| `… customers GO` | parse OK; `GO` tablo takma adı oluyor | `\bGO\b` deny |
| `OPENROWSET` | parse OK; `tableList` **boş** | isim deny (yalnız tableList = sessiz atlatma) |
| `not sql` (kısa) | parse OK; `type: assign` | select olmayan tip deny |
| `not sql at all !!!` | parse fail | parse fail → deny |
| `SELECT …; SELECT 1` | ast dizi uzunluğu 2 | çok ifade deny |
| `TOP 100 PERCENT` | parse OK | PERCENT deny |
| `SELECT id INTO x …` | parse OK | `into.type === 'into'` deny |
| 4 parça `server.db.dbo.t` | parse OK | `server` / 3+ parça deny |

UNION’da `TOP` yalnız ilk SELECT’e biner. Kapı UNION’ı `SELECT TOP n * FROM (… )` ile sarar.
