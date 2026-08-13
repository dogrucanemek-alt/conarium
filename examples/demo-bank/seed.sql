-- Demo bank schema. Every identifier is fake on purpose.
-- TCKN values are 11 digits starting with 1 and do NOT satisfy the checksum.
-- IBANs are TR00 + zeros. Names are stock "deneme" labels, not people.

CREATE TABLE accounts (
  id          serial PRIMARY KEY,
  holder_name text NOT NULL,
  tckn        text NOT NULL,
  iban        text NOT NULL,
  balance_try numeric(14, 2) NOT NULL
);

CREATE TABLE transactions (
  id          serial PRIMARY KEY,
  account_id  int NOT NULL REFERENCES accounts (id),
  amount_try  numeric(14, 2) NOT NULL,
  memo        text NOT NULL
);

CREATE TABLE card_vault (
  id         serial PRIMARY KEY,
  account_id int NOT NULL REFERENCES accounts (id),
  pan        text NOT NULL,
  cvv        text NOT NULL
);

INSERT INTO accounts (holder_name, tckn, iban, balance_try)
SELECT
  (ARRAY[
    'Ali Deneme',
    'Ayse Ornek',
    'Mehmet Sahte',
    'Fatma Test',
    'Can Yok',
    'Zeynep Demo',
    'Hasan Ornek'
  ])[1 + ((g - 1) % 7)],
  '1' || lpad((g * 17)::text, 10, '0'),
  'TR00' || lpad(g::text, 22, '0'),
  (1000 + g)::numeric(14, 2)
FROM generate_series(1, 250) AS g;

INSERT INTO transactions (account_id, amount_try, memo)
SELECT
  1 + ((g - 1) % 250),
  ((g % 97) + 1)::numeric(14, 2),
  (ARRAY['EFT deneme', 'Havale ornek', 'POS sahte', 'Maas test'])[1 + ((g - 1) % 4)]
FROM generate_series(1, 400) AS g;

INSERT INTO card_vault (account_id, pan, cvv)
SELECT
  g,
  '0000-0000-0000-' || lpad(g::text, 4, '0'),
  '000'
FROM generate_series(1, 250) AS g;
