-- Local demo only. Names are obviously fake.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

CREATE TABLE public.patients (
  id    serial PRIMARY KEY,
  name  text NOT NULL,
  note  text NOT NULL
);

CREATE TABLE public.vitals (
  id         serial PRIMARY KEY,
  patient_id int NOT NULL REFERENCES public.patients(id),
  reading    text NOT NULL
);

CREATE TABLE public.billing (
  id         serial PRIMARY KEY,
  patient_id int NOT NULL REFERENCES public.patients(id),
  amount     numeric(10, 2) NOT NULL
);

INSERT INTO public.patients (name, note) VALUES
  ('Ada Example', 'first row'),
  ('Ben Sample', 'second row'),
  ('Cara Demo', 'third row');

INSERT INTO public.vitals (patient_id, reading) VALUES
  (1, '120/80'),
  (2, '110/70');

INSERT INTO public.billing (patient_id, amount) VALUES
  (1, 40.00),
  (2, 25.00);

CREATE ROLE conarium_gate LOGIN PASSWORD 'gate-demo-not-prod' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE conarium_demo TO conarium_gate;
GRANT USAGE ON SCHEMA public TO conarium_gate;
GRANT SELECT ON TABLE public.patients TO conarium_gate;
GRANT SELECT ON TABLE public.vitals TO conarium_gate;
GRANT SELECT ON TABLE public.billing TO conarium_gate;
GRANT SELECT ON pg_stat_statements TO conarium_gate;
