-- Ken's Home Warehouse: cloud sync setup for Supabase.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to run more than once.

-- One row per app document (locations/…, items/…, meta/…). Only the signed-in owner can see their rows.
create table if not exists public.docs (
  user_id   uuid not null default auth.uid() references auth.users on delete cascade,
  path      text not null,
  data      jsonb,
  ts        bigint not null,                 -- when the device made the change (ms); newest wins
  deleted   boolean not null default false,
  server_ts timestamptz not null default now(),
  primary key (user_id, path)
);
create index if not exists docs_user_server_ts on public.docs (user_id, server_ts);

alter table public.docs enable row level security;
drop policy if exists "own docs" on public.docs;
create policy "own docs" on public.docs for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Keep the newer edit when two devices change the same thing; stamp server time for incremental pulls.
create or replace function public.docs_before_write() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.ts < old.ts then
    return null;                                -- older edit arrived late: keep what's there
  end if;
  new.server_ts := clock_timestamp();
  return new;
end $$;
drop trigger if exists docs_before_write on public.docs;
create trigger docs_before_write before insert or update on public.docs
  for each row execute function public.docs_before_write();

-- Private photo storage: each user can only touch files under their own folder.
insert into storage.buckets (id, name, public) values ('photos', 'photos', false)
  on conflict (id) do nothing;
drop policy if exists "own photos select" on storage.objects;
drop policy if exists "own photos insert" on storage.objects;
drop policy if exists "own photos update" on storage.objects;
drop policy if exists "own photos delete" on storage.objects;
create policy "own photos select" on storage.objects for select
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own photos insert" on storage.objects for insert
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own photos update" on storage.objects for update
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own photos delete" on storage.objects for delete
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
