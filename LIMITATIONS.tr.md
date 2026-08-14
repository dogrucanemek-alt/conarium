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

## Operatör sınırın içindedir

Ürün asistan ↔ kapı yolunu korur. Kütüphaneyi import eden kod kapıyı,
operatörün kimlik bilgisiyle veritabanına bağlanmakla aynı yetkiyle
atlayabilir. Operatörün kendi süreci bu kapının denetim konusu değildir.

## İki süreç, tek denetim dosyası

`Audit.log()` senkrondur. Tek süreçte eşzamanlı sorgular `prevHash` kırmadan
yazar. İki OS süreci aynı sink’e kilit olmadan ekler. Kilit ayrı karar;
o kurulum desteklenmez.

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
