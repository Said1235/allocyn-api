-- One database mirrors one contract. The indexer records it on its first run and refuses to write if it changes.
alter table public.indexer_state add column contract_address text, add column network text;
