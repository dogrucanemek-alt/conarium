-- Local demo only. Names and emails are obviously fake.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

CREATE TABLE public.customers (
  id    serial PRIMARY KEY,
  name  text NOT NULL,
  email text NOT NULL,
  note  text NOT NULL
);

INSERT INTO public.customers (name, email, note) VALUES
  ('Ada Example', 'ada@example.com', 'first row'),
  ('Ben Sample', 'ben@example.com', 'second row'),
  ('Cara Demo', 'cara@example.com', 'third row');

CREATE ROLE conarium_gate LOGIN PASSWORD 'gate-demo-not-prod' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE conarium_demo TO conarium_gate;
GRANT USAGE ON SCHEMA public TO conarium_gate;
GRANT SELECT ON TABLE public.customers TO conarium_gate;
GRANT SELECT ON pg_stat_statements TO conarium_gate;
