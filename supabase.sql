create table if not exists public.sports_events (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table public.sports_events enable row level security;

drop policy if exists "public read sports events" on public.sports_events;
drop policy if exists "public insert sports events" on public.sports_events;
drop policy if exists "public update sports events" on public.sports_events;

create policy "public read sports events"
on public.sports_events for select
using (true);

create policy "public insert sports events"
on public.sports_events for insert
with check (true);

create policy "public update sports events"
on public.sports_events for update
using (true)
with check (true);
