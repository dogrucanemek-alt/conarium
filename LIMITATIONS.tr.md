# Sınırlar

Conarium'un yapmadıkları. Ölçülmüş. Tarih yok.

## Sertifikasyon yok

SOC 2 yok. ISO yok. Bağımsız sızma testi yok. Yol haritasında.

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

## Conarium henüz bir karşı-imza servisi işletmiyor

Uç nokta bu pakette geliyor ve kendin çalıştırabilirsin. Conarium'un işlettiği
halka açık bir tanesi yok; dolayısıyla "imzalayan sen değilsin" argümanına
dayanan katman bugün bir servis değil, çalıştırabileceğin bir kod.

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

## OpenTimestamps istemcisi

Damgalama yerleşik takvim istemcisiyle yapılır (Node `crypto` + herkese açık takvimlere HTTPS).
`javascript-opentimestamps` bağımlılık değil. `web3` / `elliptic` / `crypto-js` / `request` / `lodash` ağacı kurulmaz.
Bitcoin onayı yine saatler sürebilir; makbuz `pending` gösterir.
Bitcoin blok doğrulaması `blockstream.info`'ya sorar. O host yoksa doğrulayıcı "kontrol edemedim" der, "geçerli" demez.
