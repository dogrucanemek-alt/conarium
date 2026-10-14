# Sınırlar

Conarium'un yapmadıkları. Ölçülmüş. Tarih yok.

## Sertifikasyon yok
<!-- s: no-certification -->

SOC 2 yok. ISO/IEC 27001 yok. İkisi de planlanmıyor: bu aşamada öncelik,
kurumsal sertifikasyon değil, bağımsız sızma testi ve uygulama düzeyinde
güvence. Bağımsız sızma testi de henüz yok — o yol haritasında.

## 1.0 değil
<!-- s: not-1.0 -->

Sürüm 0.3.x. API kırılabilir.

## Taban Node 20, ve Node 20 artık yama almıyor
<!-- s: node-20-floor -->

`engines` Node >=20 ister. CI tam paketi 20, 22 ve 24'te koşar. 2026-08-17'ye
kadar taban >=18 yazıyordu; bu doğrulanmamış değil, yanlıştı. MCP SDK'nın HTTP
taşıması global `crypto`'yu kullanır ve bayraksız hali Node 19'dan itibaren
var. Node 18'de kapı `initialize`'da `ReferenceError: crypto is not defined`
ile düşer.

nodejs/Release takviminde Node 18 (2025-04-30) ve Node 20 (2026-04-30)
destek dışı. Node 20 kuran, güvenlik yaması gelmeyen bir çalışma zamanı
çalıştırıyor. Taban yine 20: o sürümde paket yeşil, kaldırmak ise
operatörün seçmediği bir sebeple kurulumları kırardı. Çalıştırılacak olan
Node 22 veya üstü. Hâlâ 20'daysan bu cümle duruyor diye duruyor; gizlenmiyor.

## SQL: Postgres, Microsoft SQL Server ve Oracle
<!-- s: sql-dialects -->

MySQL yok.
Bir lehçe ancak paylaşılan SQL-kapısı vektör seti o lehçede yeşilse, ayrıştırılamayan girdi reddediliyorsa ve canlı motorda satır tavanı uygulanıyorsa burada yazılır.
Bu bir dağıtılan veritabanı istemcisi değil, ikinci ayrıştırıcı katmanı. Dağıtılan `query` aracı kapıyı `policy.dialect` ile seçer (yoksa `postgres`; `mssql`; `oracle`). Lehçe operatörün beyanıdır — SQL’den tahmin edilmez. Bilinmeyen lehçe yapılandırmayı reddeder; sessizce postgres’e düşmez.
Oracle synonym hedefini çözmez: allow-list’teki ad, parser’ın gördüğü addır, taban tablo değil. Veritabanı bağlantısı (`table@dblink`) reddedilir. `ROWNUM` reddedilir (satır tavanı değildir).
MSSQL veya Oracle konnektörü yok. Operatör kendi çalıştırıcısını takabilir (`connectors[].type: custom-sql`); çalıştırıcıya yalnız kapıdan geçmiş SQL gider. Bu yolda `policy.dialect` zorunludur — yoksa postgres varsayılanı uygulanmaz. Kapı üç lehçeyi yönetir; bağlantıyı operatör getirir.
Ayrıştırıcılar: Postgres `pgsql-ast-parser` · MSSQL `node-sql-parser` (transactsql) · Oracle `@guanmingchiu/sqlparser-ts`.

## Çıplak 9 haneli ABD SSN içerik dedektörü değil
<!-- s: bare-ssn -->

`XXX-XX-XXXX` (tireli) maskelenir. Çıplak 9 haneli koşu maskelenmez:
sipariş numarası ve benzeri kimliklerle çakışır. Ölçülmüş sınır, unutkanlık değil.

## Serbest metinde isim garantisi yok
<!-- s: names-free-text -->

Yapılandırılmış kolonlar: deterministik (`maskColumns`).
Serbest metin: en iyi çaba (bu politikanın zaten maskelediği değerlerin taşınması; etiketli isimler).
Düz cümledeki çıplak isim yakalanmaz.

## Etiketli bir sır ilk ayırıcıya kadar maskelenir
<!-- s: labelled-secret-first-delimiter -->

`password:` ya da `pwd:` gibi bir etiketten sonra değer ilk boşluğa, virgüle,
noktalı virgüle, tırnağa ya da süslü paranteze kadar maskelenir. Kalanı ancak
başka bir dedektör tanırsa maskelenir. `pwd: 4111 1111 1111 1112` girdisinde
`1111 1111 1112` okunur kalır, çünkü o kart numarası sağlamadan geçmez. 0.2.54
de aynısını yapıyordu.

## Komşularına bitişik bir numara ancak kendini kanıtlarsa bulunur
<!-- s: joined-number-windows -->

Bir numara çevresindeki kelimelere ya da numaralara tek ayırıcıyla bitişikse,
içindeki bir parça ancak sağlamadan geçerse (kart, T.C. kimlik numarası) ya da
Türk cep telefonu numarasıysa maskelenir. Bitişik bir sabit hat (`siparis 2024
02321234567`) ve önünde ayırıcı olmayan bir numara (`siparis 202410000000146`)
okunur kalır. Bazı
grupları tesadüfen sağlamadan geçen uzun bir grup dizisi, tek bir numara olmadığı
hâlde maskelenebilir.

## Her alan 0.2.54'ün maskeleme adımlarından da geçer
<!-- s: legacy-belt -->

Her alan 0.2.54 adımlarının dondurulmuş bir kopyasından da geçirilir ve o
kopyanın maskelediği her aralık yeniden maskelenir. Bunun bir süre bedeli var:
karşılaştırma girdilerinde maskeleme 0.2.54'ün en çok yaklaşık dört katı sürdü
(yoğun e-posta adresleriyle dolu bir megabaytlık alan, yaklaşık 170 ms), diğerlerinde
en çok yaklaşık üç katı. Kopyanın çıktısı metinle hizalanamazsa alanın tamamı
maskelenir. O zaman maskeli bir değerin yanındaki, kişisel olmayan bir metin de
gizlenebilir: maskeli bir numaranın yanındaki noktasız bir unvan (`Bay`, `Bayan`)
ya da kaynak metinde aynen geçen bir özel kural etiketi.

## Özel desenler: neler reddedilir ve hangi motorda çalışırlar
<!-- s: custom-pattern-shapes -->

Özel desenler doğrusal zamanlı bir düzenli ifade motorunda (re2js) çalışır; bu
yüzden kabul edilen hiçbir desen bir alanın maskelenmesini dakikalarca
kilitleyemez. 0.2.54'te bazıları kilitleyebiliyordu. Politika yüklenirken
reddedilen desenler 0.2.54'ün reddettikleridir (ileri/geri bakış, geri başvuru,
`+`, `*`, üst sınırı olmayan `{n,}` ve eski grup kuralları); buna, motorun
JavaScript'ten farklı eşleşeceği dört biçim eklendi:

- çok satır bayrağını açan bir değiştirici grup (`(?m:…)`; JavaScript'in çok
  satırlı `^` ve `$`'ı satır başı karakterinde, U+2028 ve U+2029'da da durur);
- büyük/küçük harf duyarsız bir değiştirici grup (`(?i:…)`) içeren ve herhangi
  bir yerinde `\w`, `\W`, `\b` ya da `\B` kullanan bir desen (Node 24'te böyle bir
  grup, `\w`'nin grubun dışında da Kelvin işaretini ve uzun s'yi almasına yol
  açar);
- boş bir seçeneği boş olmayan bir seçenekten önce sayan isteğe bağlı ya da
  yinelenen bir grup, örneğin `(?:|a)?` veya `(?:a??)?` (JavaScript o konumda
  boş seçeneği atlar, motor alır). Kural yapısaldır; bu yüzden iki motorun aynı
  eşleyeceği bazı grupları da reddeder, örneğin `(?:$|a)?`;
- bir `\uHHHH\uLLLL` çiftinin yarısı olmayan bir vekil kaçışı, örneğin
  `\u{D83D}`, ya da ham karakter olarak yazılmış tek bir vekil.

0.2.54'ün niceleyici sınırı, yalnız ondalık rakamlarla yazılmış süslü
parantezli bir kaçışı da niceleyici sayar: `\u{100}`, `\u{65}` ve `\u{2028}`,
0.2.54'te olduğu gibi, sınırsız ya da iç içe niceleyici diye reddedilir;
`\u0100`, `\u0065` ve `\u2028` kabul edilir.

Değiştirici gruplar, 0.2.54'te olduğu gibi, yalnız bunları destekleyen Node
sürümlerinde derlenir. Unicode özellik sınıfları (`\p{…}`, `\P{…}`) kod
noktalarını Conarium'un çalıştığı JavaScript motorundan alır; bu yüzden aynı
Node'da 0.2.54'ün eşlediğini eşler. Her özelliğin ilk kullanımı politika
yüklenirken süreç başına bir kez yaklaşık 25–45 ms tutar. Eşleşmelerin
JavaScript'in `u` bayraklı eşleşmeleriyle aynı olması amaçlanır. Bu, harf, rakam,
sınıf ve olumsuz sınıf (içlerinde `\s`, `\S` ve `\b` ile), `[^]`, `.`, `\s`, `\d`,
`\w`, `\b`, `^`, `$`, `\u` kaçışları, sınırlı ve tembel niceleyici, boş seçenekli
alternasyon ve `i`/`s` değiştirici grupları içeren üretilmiş desenlerde, metinde
satır sonu, bölünmez boşluk ve diğer Unicode boşlukları, Kelvin işareti ve uzun s
ile; listelenmiş vekil çifti ve sınıf kenar durumlarında; ve JavaScript'in Node
24'te kabul ettiği her Unicode özellik adında sınandı: kısa ve uzun adıyla bütün
genel kategoriler, ECMAScript tablosundaki her ikili özellik ve kısaltması, ve
`Script=`, `sc=`, `Script_Extensions=` ve `scx=` altında 175 betik ile 169 dört
harfli kısaltması. İki fark kalır:

- bir emojinin iki yarısı arasındaki boş eşleşme (örneğin `\B`); JavaScript bunu
  bildirir, motor bildirmez. İki durumda da hiçbir metin gizlenmez;
- büyük/küçük harf duyarsız bir değiştirici grubun içinde ve bir sınıfın
  dışında, Latin-1 dışındaki yedi harf, ister harf ister kaçış olarak yazılsın
  (Ÿ, ſ, Μ, μ, ẞ, Kelvin işareti `\u212A` ve Ångström işareti `\u212B`), motorda
  her metinde Latin-1'deki büyük/küçük eşleriyle (ÿ; s ve S; µ; µ; ß; k ve K; å
  ve Å) eşleşir. Node 24'te JavaScript bunları yalnız metinde Latin-1 dışında
  bir karakter de varsa eşler. Motor orada daha çok maskeler; JavaScript'in
  gizleyeceği hiçbir şeyi açık bırakmaz. Bir sınıfın içinde (`(?i:[\u212A])`)
  ikisi de eşleri eşler.

## Tek üretim kurulumu
<!-- s: one-prod-install -->

Tek üretim kurulumu yazarın kendi şirketi.
Dış referans müşteri yok.
121.366 kimlik maskelendi rakamı o şirketin ERP'sinden gelir. Dışarıdan doğrulanamaz.

## Tek kişilik ekip
<!-- s: one-person-team -->

Bus factor 1.

## Çıpa beklemede kalabilir
<!-- s: anchors-pending -->

OpenTimestamps damgasının Bitcoin'de onaylanması saatler sürebilir. Makbuz
`anchor: null` ile doğar. `pending` ancak operatör damgayı gönderdikten sonra
görünür (`conarium-stamp` veya `conarium-anchor-service`).

## Maskeleme değeri gizler; öğrenilemez kılmaz
<!-- s: masking-unlearnable -->

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
<!-- s: row-cap-per-query -->

`maxRows` tek sorguyu sınırlar. `OFFSET` korunur; izinli ve maskesiz bir tablo
tavan boyunda sayfalarla baştan sona okunabilir. Tabloya izin vermek budur;
tavan tek sorguluk toplu sızdırmayı durdurmak ve sonuç kümesini küçük tutmak
için vardır, toplam erişimi karneye bağlamak için değil.

## Karşı-imza, verinin doğruluğu hakkında bir beyan değildir
<!-- s: countersign-not-data -->

Karşı-imza servisi şunu söyler: senden başka bir imzalayan bu zincir başını şu
anda gördü ve üzerine eklenen, yeniden yazılmayan bir kütükte şu sıraya koydu.
Kayıtların doğru olduğunu söylemez; karşı-imzalayanın dürüst olduğunu da
iddia etmez — yalnızca kütüğün kendi geçmişinin sonradan sessizce yeniden
dizilemeyeceğini söyler. İmza anahtarı sızarsa, o anahtarın attığı bütün
imzalar anahtar kadar değerlidir: hiç.

## Karşı-imza servisi tek sunucuda tek anahtardır
<!-- s: countersign-one-key -->

2026-08-15'ten beri Conarium'un işlettiği bir uç nokta var
(`demo.conarium.dev/anchor`, keyId `verax-cs-20260815`). İmza anahtarı tek
sunucuda, diskte durur; HSM yok. Şifreli bir kopyası sunucunun dışında emanette —
makinenin kaybı keyId'yi bitirmez. Ama emanet kurtarma içindir, koruma değil:
anahtar sızarsa o keyId ile atılmış her karşı-imza geçersizdir; üstteki bölüm
tam olarak bunu söylüyor. Uç nokta yine bu pakette geliyor ve kendin
çalıştırabilirsin; kendi işlettiğin karşı-imza sıralamayı sana kanıtlar, sana
güvenmeyen üçüncü tarafa değil.

## Operatör sınırın içindedir
<!-- s: operator-inside -->

Ürün asistan ↔ kapı yolunu korur. Kütüphaneyi import eden kod kapıyı,
operatörün kimlik bilgisiyle veritabanına bağlanmakla aynı yetkiyle
atlayabilir. Operatörün kendi süreci bu kapının denetim konusu değildir.

## İki süreç, tek denetim dosyası
<!-- s: two-processes -->

`Audit.log()` senkrondur. Tek süreçte eşzamanlı sorgular `prevHash` kırmadan
yazar. Aynı sink’i açan ikinci OS süreci reddedilir (`<sink>.lock`,
advisory `wx`). Kilit, Conarium dışından dosyaya yazan süreci durdurmaz.

## Sıkı imza kipi opt-in
<!-- s: strict-sig-opt-in -->

`CONARIUM_AUDIT_REQUIRE_SIG=1` imza anahtarı varken imzasız tek satırda
boot'u reddeder. Varsayılan, HMAC sonradan eklenince tamamen imzasız
eski zinciri hâlâ açar (08-05 uyumu).

## Denetim sink'inin hash'i JCS değil
<!-- s: audit-hash-not-jcs -->

Makbuz RFC 8785 JCS ile hash'lenir (`canonicalize`). Denetim JSONL hasher'ı
(`src/audit-hash.ts`) ekleme sırasındaki `JSON.stringify`'ı kullanır.
Anahtarlar sıralı değilse iki hesap ayrışır: `{"b":1,"a":2}` ile
`{"a":2,"b":1}` aynı nesne değildir. Sink'i JCS'e çevirmek eldeki her
denetim dosyasını geçersiz kılar. Eski bir sink'i başkasının yeniden
hash'lemesi gerekiyorsa kullanacağı şey JCS değil, `JSON.stringify`'dır.

## Denetlenmemiş kriptografi
<!-- s: crypto-unaudited -->

Ed25519 uygulaması resmî denetimden geçmedi.

## Maskeleme maliyeti satırla değil, benzersiz değerle büyür
<!-- s: masking-cost -->

Taşıma eşleştiricisi, politikanın maskelediği her benzersiz değer için
bir tarama kurar. `maxRows` o kümeyi sınırlar. Politika boş bırakırsa kod 100'e
düşer; pakette gelen `conarium.config.json` 50 yazar. Taze kurulum 50'de çalışır.
Aşağıdaki ölçüm ihtiyatlı olsun diye 100 üzerinden.

Ölçülmüş (aynı SELECT, aynı satır sayısı, Postgres 16.15, win32/Node 24, bakınız
[`docs/BENCHMARK.md`](docs/BENCHMARK.md)):

| maxRows | ek yük p50 (maskeli) |
|---|---|
| 100 (varsayılan) | 2,7 ms |
| 500 | 8,8 ms |
| 5 000 | 93 ms |

Tavanı yükseltmek serbest. 500'ün üstünde doctor ve boot uyarır.
Sorgu reddedilmez.

## Düşük entropili yükte disclosure hash'i doğrulama kehanetidir
<!-- s: disclosure-oracle -->

`disclosure.hash`, maskeleme ve satır tavanından sonra sınırdan çıkan
baytların SHA-256'sıdır. Makbuzu elinde tutan biri "cevap `evet` miydi?"
diye deneyip hash'in tutup tutmadığına bakabilir. Bu hash'in doğasıdır,
gizli bir özellik değil. Nonce kapatmaz: nonce da aynı makbuzda durur.
Yüksek entropili sonuç pratikte bu yolla tahmin edilmez. Tek satırlık
evet/hayır sonucu edilir.

## Hedef beyandır, doğrulanmaz
<!-- s: destination-declaration -->

`destination` operatörün config'e yazdığıdır. Conarium sonucun oraya
gittiğini kontrol etmez. MCP model kimliği taşımaz, yani alan ölçülemez.
Politika onu okumaz. Makbuzda `openai/gpt-x` yazması, baytları OpenAI'ın
gördüğü anlamına gelmez.

## Mutabakat nesneyi bağlar, her ifadeyi değil
<!-- s: reconcile-object-attribution -->

`conarium-reconcile` çıkış 0'ı şuna verir: veritabanının saydığı her sorgu
deseni, aynı pencerede bir makbuzun adlandırdığı bir tabloya bağlanır. Bir
tabloyu adlandıran tek makbuz, o pencerede o tabloya giden başka kaç ifade
olursa olsun hepsini temizler. `test/reconcile_cli.test.mjs` bunu bilerek
pozitif örnek tutar — sayaç farkı aynı desende beş çağrı, bir makbuz tabloyu
adlandırır, koşu 0 döner. Sayılar kasıtlı olarak 1:1 karşılaştırılmaz: bir
istemci isteği birden fazla kaynak ifadesi üretebilir (PostgREST, bağlantı
havuzu, ORM). 1:1 kuralı böyle her kurulumda sahte "kapsanmamış etkinlik"
üretir. Temiz koşunun kurduğu şey pencere içinde desen ve nesne
örtüşmesidir. Kayda geçmiş her ifadenin ayrıca makbuzlandığını kurmaz.
`--json-v2` ayrı bir `coverage-reconciliation/2` nesnesi basar; `/1` sonucu
`/2` diye okunmaz. Mapping Profile yoksa `/2` çokluğa bağlı kalemleri
`matched` saymaz, `indeterminate` bırakır.

## OpenTimestamps istemcisi
<!-- s: ots-client -->

Damgalama yerleşik takvim istemcisiyle yapılır (Node `crypto` + herkese açık takvimlere HTTPS).
`javascript-opentimestamps` bağımlılık değil. `web3` / `elliptic` / `crypto-js` / `request` / `lodash` ağacı kurulmaz.
Bitcoin onayı yine saatler sürebilir; `pending` yalnız damga gönderildikten sonra görünür.
Bitcoin blok doğrulaması `blockstream.info`'ya sorar. O host yoksa doğrulayıcı "kontrol edemedim" der, "geçerli" demez.

## Demo kipi örnek satır kullanır
<!-- s: demo-mode -->

`conarium --demo` bellek içi örnek satır sunar. Veritabanı açmaz; dağıtılan
bağlayıcıların hiçbirini çalıştırmaz. Yapılandırma dosyasında `type: "demo"`
reddedilir; o bağlayıcı `--demo` bayrağıyla kurulur. Örnek bağlayıcı yalnız
`SELECT <sütunlar | *> FROM <örnek tablo>` biçimini cevaplar ve ifadenin adını
verdiği sütunları döndürür, fazlasını değil; `WHERE`, `JOIN`, hesaplanmış ifade
ve takma ad yok sayılmaz, reddedilir.

## Mutabakat, kayan saatle geç yazılmış makbuzu ayıramaz
<!-- s: reconcile-trailing-clock -->

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
