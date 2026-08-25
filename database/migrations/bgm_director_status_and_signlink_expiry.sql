-- Directors can be disabled with an explicit reason (inactive/suspended/resigned/
-- retired), and emailed no-login signing links carry an expiry.
alter table public.directors drop constraint if exists directors_status_check;
alter table public.directors add constraint directors_status_check
  check (status = any (array['active','inactive','suspended','resigned','retired']));

alter table public.meeting_attendance add column if not exists checkin_token_expires_at timestamptz;
alter table public.meeting_guests    add column if not exists checkin_token_expires_at timestamptz;
comment on column public.meeting_attendance.checkin_token_expires_at is 'Expiry of the emailed no-login signing link (checkin_token). Null = no expiry.';
