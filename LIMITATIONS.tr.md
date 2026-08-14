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

## Postgres'e göre ek yük ölçülmedi

Aynı sorgunun doğrudan Postgres ile Conarium üzerinden p50 / p95 / p99
farkı bu depoda yok. `scripts/benchmark-overhead.mjs` son koşusunda
yerel Postgres yoktu (koşulamadı).

Veritabanı olmadan maskeleme: 1 000 ayrı e-posta p50 ≈ 205 ms. 100 000
ayrı e-posta 6 dakikada bitmedi (taşıma eşleştiricisi her benzersiz
maskeli değerde büyür). Tekrar: [`docs/BENCHMARK.md`](docs/BENCHMARK.md).

## OpenTimestamps istemcisi

Damgalama yerleşik takvim istemcisiyle yapılır (Node `crypto` + herkese açık takvimlere HTTPS).
`javascript-opentimestamps` bağımlılık değil. `web3` / `elliptic` / `crypto-js` / `request` / `lodash` ağacı kurulmaz.
Bitcoin onayı yine saatler sürebilir; makbuz `pending` gösterir.
Bitcoin blok doğrulaması `blockstream.info`'ya sorar. O host yoksa doğrulayıcı "kontrol edemedim" der, "geçerli" demez.
