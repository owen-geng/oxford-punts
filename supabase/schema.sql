-- Oxford Punts poker ledger schema
-- Append-only double-entry ledger. Invariants enforced here, not in the client:
--   1. Every transaction's entries sum to zero (deferred constraint trigger)
--   2. Settlements have exactly 2 entries
--   3. History is immutable: UPDATE/DELETE on ledger tables always raises
--   4. Anonymous clients can only read; all writes go through validated RPCs

create table public.players (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(trim(name)) between 1 and 40),
  created_at timestamptz not null default now()
);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('session', 'settlement')),
  note text check (length(note) <= 200),
  -- set when this transaction reverses an earlier one; unique = at most one reversal per transaction
  reverses uuid unique references public.transactions (id),
  created_at timestamptz not null default now()
);

create table public.entries (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions (id),
  player_id uuid not null references public.players (id),
  amount_pence bigint not null check (amount_pence <> 0),
  unique (transaction_id, player_id)
);

create index entries_player_idx on public.entries (player_id);

create view public.balances with (security_invoker = true) as
  select p.id, p.name,
         coalesce(sum(e.amount_pence), 0)::bigint as balance_pence,
         count(e.id)::int as entry_count
  from public.players p
  left join public.entries e on e.player_id = p.id
  group by p.id, p.name;

-- ---------------------------------------------------------------------------
-- Invariant: transactions are balanced, >= 2 entries, settlements exactly 2.
-- Deferred constraint triggers run at COMMIT, when all rows are in place.
-- ---------------------------------------------------------------------------
create or replace function public.check_transaction_valid() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_tid uuid;
  v_sum bigint;
  v_count int;
  v_kind text;
begin
  if tg_table_name = 'transactions' then
    v_tid := new.id;
  else
    v_tid := new.transaction_id;
  end if;
  select coalesce(sum(amount_pence), 0), count(*) into v_sum, v_count
    from entries where transaction_id = v_tid;
  select kind into v_kind from transactions where id = v_tid;
  if v_count < 2 then
    raise exception 'transaction % must have at least 2 entries (has %)', v_tid, v_count;
  end if;
  if v_sum <> 0 then
    raise exception 'transaction % is unbalanced: entries sum to % pence, must be 0', v_tid, v_sum;
  end if;
  if v_kind = 'settlement' and v_count <> 2 then
    raise exception 'settlement % must have exactly 2 entries', v_tid;
  end if;
  return null;
end $$;

create constraint trigger transactions_valid
  after insert on public.transactions
  deferrable initially deferred
  for each row execute function public.check_transaction_valid();

create constraint trigger entries_balanced
  after insert on public.entries
  deferrable initially deferred
  for each row execute function public.check_transaction_valid();

-- ---------------------------------------------------------------------------
-- Invariant: append-only. Triggers bind even SECURITY DEFINER functions.
-- ---------------------------------------------------------------------------
create or replace function public.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'ledger is append-only: % on % is not allowed; post a reversal instead',
    tg_op, tg_table_name;
end $$;

create trigger transactions_append_only
  before update or delete on public.transactions
  for each row execute function public.forbid_mutation();

create trigger entries_append_only
  before update or delete on public.entries
  for each row execute function public.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Write API (the only way in): validated, atomic RPCs
-- ---------------------------------------------------------------------------
create or replace function public.add_player(p_name text) returns public.players
language plpgsql security definer set search_path = public as $$
declare
  v_player players;
begin
  if p_name is null or length(trim(p_name)) not between 1 and 40 then
    raise exception 'player name must be 1-40 characters';
  end if;
  begin
    insert into players (name) values (trim(p_name)) returning * into v_player;
  exception when unique_violation then
    raise exception 'player "%" already exists', trim(p_name);
  end;
  return v_player;
end $$;

-- p_entries: [{"player_id": "<uuid>", "amount_pence": <int>}, ...]
create or replace function public.record_transaction(p_kind text, p_note text, p_entries jsonb)
returns public.transactions
language plpgsql security definer set search_path = public as $$
declare
  v_tx transactions;
  v_entry jsonb;
  v_count int;
  v_sum bigint := 0;
begin
  if p_kind not in ('session', 'settlement') then
    raise exception 'kind must be session or settlement';
  end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
    raise exception 'entries must be a JSON array';
  end if;
  v_count := jsonb_array_length(p_entries);
  if v_count < 2 then
    raise exception 'a transaction needs at least 2 entries';
  end if;
  if p_kind = 'settlement' and v_count <> 2 then
    raise exception 'a settlement must have exactly 2 entries';
  end if;

  insert into transactions (kind, note)
    values (p_kind, nullif(trim(coalesce(p_note, '')), ''))
    returning * into v_tx;

  for v_entry in select * from jsonb_array_elements(p_entries) loop
    insert into entries (transaction_id, player_id, amount_pence)
      values (v_tx.id, (v_entry->>'player_id')::uuid, (v_entry->>'amount_pence')::bigint);
    v_sum := v_sum + (v_entry->>'amount_pence')::bigint;
  end loop;

  if v_sum <> 0 then
    raise exception 'entries must sum to zero (got % pence)', v_sum;
  end if;
  return v_tx;
end $$;

create or replace function public.reverse_transaction(p_transaction_id uuid, p_note text default null)
returns public.transactions
language plpgsql security definer set search_path = public as $$
declare
  v_orig transactions;
  v_tx transactions;
begin
  select * into v_orig from transactions where id = p_transaction_id;
  if not found then
    raise exception 'transaction % not found', p_transaction_id;
  end if;
  if exists (select 1 from transactions where reverses = p_transaction_id) then
    raise exception 'transaction % has already been reversed', p_transaction_id;
  end if;
  insert into transactions (kind, note, reverses)
    values (v_orig.kind, coalesce(nullif(trim(p_note), ''), 'Reversal'), v_orig.id)
    returning * into v_tx;
  insert into entries (transaction_id, player_id, amount_pence)
    select v_tx.id, player_id, -amount_pence from entries where transaction_id = v_orig.id;
  return v_tx;
end $$;

-- ---------------------------------------------------------------------------
-- Access control: anyone may read; nobody writes tables directly
-- ---------------------------------------------------------------------------
alter table public.players enable row level security;
alter table public.transactions enable row level security;
alter table public.entries enable row level security;

create policy read_players on public.players for select using (true);
create policy read_transactions on public.transactions for select using (true);
create policy read_entries on public.entries for select using (true);

revoke insert, update, delete on public.players, public.transactions, public.entries
  from anon, authenticated;

grant select on public.balances to anon, authenticated;
grant execute on function
  public.add_player(text),
  public.record_transaction(text, text, jsonb),
  public.reverse_transaction(uuid, text)
to anon, authenticated;
