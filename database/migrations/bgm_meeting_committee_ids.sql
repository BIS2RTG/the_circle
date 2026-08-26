-- Multi-committee board meetings: a committee meeting can span more than one
-- committee. committee_ids holds all selected committees; committee_id keeps the
-- primary (first) one for backwards compatibility with existing single-committee
-- reads and the committees(...) foreign-key join.
alter table public.board_meetings add column if not exists committee_ids uuid[];
comment on column public.board_meetings.committee_ids is 'For committee meetings spanning multiple committees: all selected committee ids. committee_id holds the primary (first) for back-compat.';
