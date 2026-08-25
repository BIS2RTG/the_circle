-- A single voucher request can generate several vouchers (the "number of
-- vouchers" set on a meal voucher). Each gets its own sequential number;
-- voucher_numbers holds them all, voucher_number keeps the first for back-compat.
alter table public.vouchers add column if not exists voucher_numbers text[];
comment on column public.vouchers.voucher_numbers is 'All sequential voucher numbers issued for this request (one per requested copy). voucher_number holds the first for back-compat.';
