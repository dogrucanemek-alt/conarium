# Sınırlar

Conarium'un yapmadıkları. Ölçülmüş. Tarih yok.

## Sertifikasyon yok

SOC 2 yok. ISO/IEC 27001 yok. İkisi de planlanmıyor: bu aşamada öncelik,
kurumsal sertifikasyon değil, bağımsız sızma testi ve uygulama düzeyinde
güvence. Bağımsız sızma testi de henüz yok — o yol haritasında.

## 1.0 değil

Sürüm 0.2.x. API kırılabilir.

## SQL: Postgres, Microsoft SQL Server ve Oracle

MySQL yok.
Bir lehçe ancak paylaşılan SQL-kapısı vektör seti o lehçede yeşilse, ayrıştırılamayan girdi reddediliyorsa ve canlı motorda satır tavanı uygulanıyorsa burada yazılır.
Bu bir dağıtılan veritabanı istemcisi değil, ikinci ayrıştırıcı katmanı. Dağıtılan `query` aracı kapıyı `policy.dialect` ile seçer (yoksa `postgres`; `mssql`; `oracle`). Lehçe operatörün beyanıdır — SQL’den tahmin edilmez. Bilinmeyen lehçe yapılandırmayı reddeder; sessizce postgres’e düşmez.
Oracle synonym hedefini çözmez: allow-list’teki ad, parser’ın gördüğü addır, taban tablo değil. Veritabanı bağlantısı (`table@dblink`) reddedilir. `ROWNUM` reddedilir (satır tavanı değildir).
MSSQL veya Oracle konnektörü yok. Operatör kendi çalıştırıcısını takabilir (`connectors[].type: custom-sql`); çalıştırıcıya yalnız kapıdan geçmiş SQL gider. Bu yolda `policy.dialect` zorunludur — yoksa postgres varsayılanı uygulanmaz. Kapı üç lehçeyi yönetir; bağlantıyı operatör getirir.
Ayrıştırıcılar: Postgres `pgsql-ast-parser` · MSSQL `node-sql-parser` (transactsql) · Oracle `@guanmingchiu/sqlparser-ts`.

## Çıplak 9 haneli ABD SSN içerik dedektörü değil

`XXX-XX-XXXX` (tireli) maskelenir. Çıplak 9 haneli koşu maskelenmez:
sipariş numarası ve benzeri kimliklerle çakışır. Ölçülmüş sınır, unutkanlık değil.

## Serbest metinde isim garantisi yok

Yapılandırılmış kolonlar: deterministik (`maskColumns`).
Serbest metin: en iyi çaba (bu politikanın zaten maskelediği değerlerin taşınması; etiketli isimler).
Düz cümledeki çıplak isim yakalanmaz.

## Tek üretim kurulumu

Tek üretim kurulumu yazarın kendi şirketi.
Dış referans müşteri yok.
121.366 kimlik maskelendi rakamı o şirketin ERP'sinden gelir. Dışarıdan doğrulanamaz.

## Tek kişilik ekip

Bus factor 1.

## Çıpa beklemede kalabilir

OpenTimestamps damgasının Bitcoin'de onaylanması saatler sürebilir. Makbuzda `pending` zaten görünür.

## Maskeleme değeri gizler; öğrenilemez kılmaz

Maskeleme sonuç satırlarına uygulanır. Sorgunun WHERE koşulu tablo izni için
denetlenir, yeniden yazılmaz: izinli bir tabloda `WHERE email LIKE 'a%'`
veritabanına gider ve bir/sıfır satır sayısı, maskeli değeri hiç göstermeden
onun hakkındaki bir soruyu cevaplar. Geçerli jetonu olan bir asistan maskeli
değerleri bu yolla parça parça öğrenebilir. Bir sütunun yalnızca gizli değil
**öğrenilemez** olması gerekiyorsa, onu taşıyan tabloya izin verme.

`policy.protectedColumns` listesindeki bir sütun daha dar bir istisnadır:
sözdizimi `maskColumns` ile aynıdır ve değer sonuçta yine maskelenir. Ayrıca
sütun `WHERE`, `HAVING`, `JOIN … ON`, `ORDER BY`, `GROUP BY` veya türetilmiş
bir `SELECT` ifadesinde geçemez — sorgu veritabanına gitmeden reddedilir.
Listede olmayan sütunlar için yukarıdaki paragraf aynen geçerlidir. Bu,
maskelenen değerlerin genel olarak öğrenilemez olduğu iddiası değildir.

## Satır tavanı sorgu başınadır, oturum başına değil

`maxRows` tek sorguyu sınırlar. `OFFSET` korunur; izinli ve maskesiz bir tablo
tavan boyunda sayfalarla baştan sona okunabilir. Tabloya izin vermek budur;
tavan tek sorguluk toplu sızdırmayı durdurmak ve sonuç kümesini küçük tutmak
için vardır, toplam erişimi karneye bağlamak için değil.

## Karşı-imza, verinin doğruluğu hakkında bir beyan değildir

Karşı-imza servisi şunu söyler: senden başka bir imzalayan bu zincir başını şu
anda gördü ve üzerine eklenen, yeniden yazılmayan bir kütükte şu sıraya koydu.
Kayıtların doğru olduğunu söylemez; karşı-imzalayanın dürüst olduğunu da
iddia etmez — yalnızca kütüğün kendi geçmişinin sonradan sessizce yeniden
dizilemeyeceğini söyler. İmza anahtarı sızarsa, o anahtarın attığı bütün
imzalar anahtar kadar değerlidir: hiç.

## Karşı-imza servisi tek sunucuda tek anahtardır

2026-08-15'ten beri Conarium'un işlettiği bir uç nokta var
(`demo.conarium.dev/anchor`, keyId `verax-cs-20260815`). İmza anahtarı tek
sunucuda, diskte durur; HSM yok. Şifreli bir kopyası sunucunun dışında emanette —
makinenin kaybı keyId'yi bitirmez. Ama emanet kurtarma içindir, koruma değil:
anahtar sızarsa o keyId ile atılmış her karşı-imza geçersizdir; üstteki bölüm
tam olarak bunu söylüyor. Uç nokta yine bu pakette geliyor ve kendin
çalıştırabilirsin; kendi işlettiğin karşı-imza sıralamayı sana kanıtlar, sana
güvenmeyen üçüncü tarafa değil.

## Operatör sınırın içindedir

Ürün asistan ↔ kapı yolunu korur. Kütüphaneyi import eden kod kapıyı,
operatörün kimlik bilgisiyle veritabanına bağlanmakla aynı yetkiyle
atlayabilir. Operatörün kendi süreci bu kapının denetim konusu değildir.

## İki süreç, tek denetim dosyası

`Audit.log()` senkrondur. Tek süreçte eşzamanlı sorgular `prevHash` kırmadan
yazar. Aynı sink’i açan ikinci OS süreci reddedilir (`<sink>.lock`,
advisory `wx`). Kilit, Conarium dışından dosyaya yazan süreci durdurmaz.

## Sıkı imza kipi opt-in

`CONARIUM_AUDIT_REQUIRE_SIG=1` imza anahtarı varken imzasız tek satırda
boot'u reddeder. Varsayılan, HMAC sonradan eklenince tamamen imzasız
eski zinciri hâlâ açar (08-05 uyumu).

## Denetlenmemiş kriptografi

Ed25519 uygulaması resmî denetimden geçmedi.

## Maskeleme maliyeti satırla değil, benzersiz değerle büyür

Taşıma eşleştiricisi, politikanın maskelediği her benzersiz değer için
bir tarama kurar. `maxRows` o kümeyi sınırlar. Politika boş bırakırsa kod 100'e
düşer; pakette gelen `conarium.config.json` 50 yazar. Taze kurulum 50'de çalışır.
Aşağıdaki ölçüm ihtiyatlı olsun diye 100 üzerinden.

Ölçülmüş (aynı SELECT, aynı satır sayısı, Postgres 16.14, WSL2, bakınız
[`docs/BENCHMARK.md`](docs/BENCHMARK.md)):

| maxRows | ek yük p50 (maskeli) |
|---|---|
| 100 (varsayılan) | 5,0 ms |
| 500 | 87 ms |
| 5 000 | 22 s |

Tavanı yükseltmek serbest. 100'ün üstünde doctor ve boot uyarır.
Sorgu reddedilmez.

## Düşük entropili yükte disclosure hash'i doğrulama kehanetidir

`disclosure.hash`, maskeleme ve satır tavanından sonra sınırdan çıkan
baytların SHA-256'sıdır. Makbuzu elinde tutan biri "cevap `evet` miydi?"
diye deneyip hash'in tutup tutmadığına bakabilir. Bu hash'in doğasıdır,
gizli bir özellik değil. Nonce kapatmaz: nonce da aynı makbuzda durur.
Yüksek entropili sonuç pratikte bu yolla tahmin edilmez. Tek satırlık
evet/hayır sonucu edilir.

## Hedef beyandır, doğrulanmaz

`destination` operatörün config'e yazdığıdır. Conarium sonucun oraya
gittiğini kontrol etmez. MCP model kimliği taşımaz, yani alan ölçülemez.
Politika onu okumaz. Makbuzda `openai/gpt-x` yazması, baytları OpenAI'ın
gördüğü anlamına gelmez.

## OpenTimestamps istemcisi

Damgalama yerleşik takvim istemcisiyle yapılır (Node `crypto` + herkese açık takvimlere HTTPS).
`javascript-opentimestamps` bağımlılık değil. `web3` / `elliptic` / `crypto-js` / `request` / `lodash` ağacı kurulmaz.
Bitcoin onayı yine saatler sürebilir; makbuz `pending` gösterir.
Bitcoin blok doğrulaması `blockstream.info`'ya sorar. O host yoksa doğrulayıcı "kontrol edemedim" der, "geçerli" demez.

## Mutabakat, kayan saatle geç yazılmış makbuzu ayıramaz

Pencerenin iki ucu veritabanının snapshot damgalarından, makbuzun damgası ise
gateway'den geliyor. Yani sınıra iki ayrı saat karar veriyor. Bir deseni
kapsayacak olan makbuz pencerenin dışına düşerse sonuç `indeterminate` olur
(çıkış 41) — "makbuzsuz erişim" denmez, çünkü araç ikisinden hangisinin olduğunu
bilemez. Bu bir hüküm değil, bir sınır: 41 başarısızlıktır, koşu geçmez, ama
hiçbir yön kanıtlanmış olmaz.

Aklama, pencerenin kendi uzunluğuyla sınırlı: pencereden uzun bir fark sınır
etkisiyle açıklanamaz ve rapor bunu mazeret göstermek yerine açıkça yazar.
`--skew` ile operatör kendi saatlerinin ne kadar kayabileceğini beyan eder ve o
beyan, araçtan çıkarılan sınırı ezer. İki kipte de makbuzun, sayaçların
kaydettiği erişime ait olduğu kanıtlanmış olmaz. Bu sınır, sınıf yayına
çıktıktan sonra **saldırıyla** bulundu; okumayla değil.
