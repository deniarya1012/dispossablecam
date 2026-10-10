create extension if not exists pgcrypto;

create table if not exists public.weddings (
  id uuid primary key default gen_random_uuid(),
  couple_names text not null default 'Yani & Deni',
  event_date text default 'October 10, 2026',
  venue text default 'Jakarta, Indonesia',
  welcome_message text not null default 'Welcome to our wedding camera. Capture the little moments, the laughter, the happy tears, and everything in between. Your memories will become part of our shared wedding album.',
  event_status text not null default 'open' check (event_status in ('open','closed')),
  gallery_visibility text not null default 'public' check (gallery_visibility in ('public','link')),
  photo_download_enabled boolean not null default true,
  show_photographer boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.invitation_codes (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  code_hash text not null unique,
  is_active boolean not null default true,
  redeemed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.guests (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  display_name text not null check (length(display_name) between 1 and 60),
  token_hash text not null unique,
  photos_used integer not null default 0 check (photos_used between 0 and 15),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.photos (
  id uuid primary key,
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  guest_id uuid not null references public.guests(id) on delete cascade,
  storage_path text not null unique,
  upload_status text not null default 'pending' check (upload_status in ('pending','accepted')),
  moderation_status text not null default 'visible' check (moderation_status in ('visible','hidden')),
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  unique (guest_id, idempotency_key)
);

create index if not exists photos_shared_gallery_idx on public.photos(wedding_id, upload_status, moderation_status, created_at desc);
create index if not exists photos_guest_idx on public.photos(guest_id, created_at desc);
create index if not exists guests_wedding_idx on public.guests(wedding_id, created_at desc);

insert into public.weddings (couple_names)
select 'Yani & Deni' where not exists (select 1 from public.weddings);

-- Guest counters include pending reservations. Row locks in reserve_photo_slot serialize concurrent requests.
create or replace function public.track_guest_photo_count()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT') then
    update public.guests set photos_used = photos_used + 1, updated_at = now() where id = new.guest_id;
    return new;
  elsif (tg_op = 'DELETE') then
    update public.guests set photos_used = greatest(photos_used - 1, 0), updated_at = now() where id = old.guest_id;
    return old;
  end if;
  return new;
end;
$$;
drop trigger if exists photos_track_count on public.photos;
create trigger photos_track_count after insert or delete on public.photos for each row execute function public.track_guest_photo_count();

create or replace function public.redeem_invitation(p_code_hash text, p_display_name text, p_token_hash text)
returns table(guest_id uuid, display_name text, photos_used integer)
language plpgsql security definer set search_path = public as $$
declare code_row public.invitation_codes%rowtype; wedding_row public.weddings%rowtype; new_guest public.guests%rowtype;
begin
  select * into code_row from public.invitation_codes where code_hash = p_code_hash and is_active and redeemed_at is null for update;
  if not found then return; end if;
  select * into wedding_row from public.weddings where id = code_row.wedding_id;
  if not found or wedding_row.event_status <> 'open' then return; end if;
  update public.invitation_codes set redeemed_at = now() where id = code_row.id;
  insert into public.guests (wedding_id, display_name, token_hash) values (code_row.wedding_id, trim(p_display_name), p_token_hash) returning * into new_guest;
  return query select new_guest.id, new_guest.display_name, new_guest.photos_used;
end;
$$;

create or replace function public.guest_from_token(p_token_hash text)
returns table(guest_id uuid, display_name text, photos_used integer)
language sql security definer set search_path = public as $$
  select g.id, g.display_name, g.photos_used from public.guests g where g.token_hash = p_token_hash limit 1;
$$;

-- The guest row lock and table constraints make quota consumption atomic, including parallel requests.
-- A retry with the same key returns its original reservation and never consumes another shot.
create or replace function public.reserve_photo_slot(p_token_hash text, p_photo_id uuid, p_idempotency_key uuid, p_storage_path text)
returns table(photo_id uuid, storage_path text, upload_status text, photos_used integer)
language plpgsql security definer set search_path = public as $$
declare guest_row public.guests%rowtype; wedding_row public.weddings%rowtype; photo_row public.photos%rowtype;
begin
  select * into guest_row from public.guests where token_hash = p_token_hash for update;
  if not found then raise exception 'GUEST_SESSION_INVALID'; end if;
  select * into wedding_row from public.weddings where id = guest_row.wedding_id;
  if not found or wedding_row.event_status <> 'open' then raise exception 'SUBMISSIONS_CLOSED'; end if;
  -- Recover abandoned requests so they cannot hold a shot forever after a crashed server process.
  delete from public.photos where guest_id = guest_row.id and upload_status = 'pending' and created_at < now() - interval '15 minutes';
  select * into guest_row from public.guests where id = guest_row.id;
  select * into photo_row from public.photos where guest_id = guest_row.id and idempotency_key = p_idempotency_key;
  if found then return query select photo_row.id, photo_row.storage_path, photo_row.upload_status, guest_row.photos_used; return; end if;
  if guest_row.photos_used >= 15 then raise exception 'PHOTO_LIMIT'; end if;
  insert into public.photos(id, wedding_id, guest_id, storage_path, idempotency_key)
  values (p_photo_id, guest_row.wedding_id, guest_row.id, p_storage_path, p_idempotency_key) returning * into photo_row;
  select * into guest_row from public.guests where id = guest_row.id;
  return query select photo_row.id, photo_row.storage_path, photo_row.upload_status, guest_row.photos_used;
end;
$$;

create or replace function public.accept_photo_upload(p_photo_id uuid, p_token_hash text)
returns boolean language plpgsql security definer set search_path = public as $$
declare photo_row public.photos%rowtype;
begin
  select p.* into photo_row from public.photos p join public.guests g on g.id = p.guest_id where p.id = p_photo_id and g.token_hash = p_token_hash for update of p;
  if not found then return false; end if;
  update public.photos set upload_status = 'accepted' where id = p_photo_id and upload_status = 'pending';
  return true;
end;
$$;

create or replace function public.release_photo_slot(p_photo_id uuid)
returns void language sql security definer set search_path = public as $$ delete from public.photos where id = p_photo_id and upload_status = 'pending'; $$;

alter table public.weddings enable row level security;
alter table public.invitation_codes enable row level security;
alter table public.guests enable row level security;
alter table public.photos enable row level security;
-- All table access goes through narrowly scoped server endpoints using the service role.
revoke all on public.weddings, public.invitation_codes, public.guests, public.photos from anon, authenticated;
revoke all on function public.redeem_invitation(text,text,text) from public, anon, authenticated;
revoke all on function public.guest_from_token(text) from public, anon, authenticated;
revoke all on function public.reserve_photo_slot(text,uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.accept_photo_upload(uuid,text) from public, anon, authenticated;
revoke all on function public.release_photo_slot(uuid) from public, anon, authenticated;
grant execute on function public.redeem_invitation(text,text,text) to service_role;
grant execute on function public.guest_from_token(text) to service_role;
grant execute on function public.reserve_photo_slot(text,uuid,uuid,text) to service_role;
grant execute on function public.accept_photo_upload(uuid,text) to service_role;
grant execute on function public.release_photo_slot(uuid) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wedding-photos', 'wedding-photos', true, 3145728, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg','image/png','image/webp'];

-- No direct client write/delete policies are created. Uploads and removals use authorized server routes.
