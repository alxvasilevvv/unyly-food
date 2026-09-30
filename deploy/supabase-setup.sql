-- One-time setup of an isolated schema + least-privilege login role for Unyly in a Supabase project.
-- Run as the "postgres" user (SQL editor or MCP). Replace the password placeholder.
CREATE ROLE unyly_app LOGIN PASSWORD '<GENERATED_PASSWORD>' NOINHERIT CONNECTION LIMIT 20;
CREATE SCHEMA unyly AUTHORIZATION unyly_app;
ALTER ROLE unyly_app SET search_path = unyly;
ALTER ROLE unyly_app SET statement_timeout = '15s';
ALTER ROLE unyly_app SET idle_in_transaction_session_timeout = '30s';
REVOKE ALL ON SCHEMA public FROM unyly_app;
-- The schema is not in PostgREST's exposed schemas, so it is not reachable through the Supabase REST API.
-- Connection (transaction pooler): postgresql://unyly_app.<project-ref>:<password>@<pooler-host>:6543/postgres
-- App env: DATABASE_URL=<that URL>, DATABASE_POOLER=transaction, DATABASE_SSL=no-verify (or DATABASE_SSL_CA=<PEM>)
-- Removal: DROP SCHEMA unyly CASCADE; DROP ROLE unyly_app;
