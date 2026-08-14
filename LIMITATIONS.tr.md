# Sınırlar

Conarium'un yapmadıkları. Ölçülmüş. Tarih yok.

## Sertifikasyon yok

SOC 2 yok. ISO yok. Bağımsız sızma testi yok. Yol haritasında.

## 1.0 değil

Sürüm 0.2.x. API kırılabilir.

## SQL yalnız Postgres

Oracle, Microsoft SQL Server ve MySQL yok.
Tasarım notu var: [`docs/specs/2026-08-14-oracle-mssql-dialect-design.md`](docs/specs/2026-08-14-oracle-mssql-dialect-design.md).
Kod yok.
Bu bir konnektör değil, ikinci ayrıştırıcı katmanı. Bugünkü güvenlik kapısı `pgsql-ast-parser` üstünde duruyor. Yeni lehçe o katmanı yeniden kurar.

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

## Denetlenmemiş kriptografi

Ed25519 uygulaması resmî denetimden geçmedi.

## Maskeleme maliyeti satırla değil, benzersiz değerle büyür

Taşıma eşleştiricisi, politikanın maskelediği her benzersiz değer için
bir tarama kurar. `maxRows` o kümeyi sınırlar. Varsayılan `maxRows` 100.

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
