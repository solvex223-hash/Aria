-- Run this once in Supabase: Dashboard > SQL Editor > New query > paste > Run.
-- It creates the table where Aria keeps its WhatsApp login so Render restarts don't lose it.

create table if not exists public.wa_auth (
  session    text        not null,
  id         text        not null,
  value      text        not null,
  updated_at timestamptz not null default now(),
  primary key (session, id)
);

-- Lock the table. Only the server-side service_role key can read or write it.
-- The public/anon key gets nothing, because this table holds live WhatsApp login keys.
alter table public.wa_auth enable row level security;
