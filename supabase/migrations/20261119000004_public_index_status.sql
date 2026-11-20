-- The API reports when the copy was last refreshed and which contract it mirrors, using only the public key.
-- Only these columns are readable by the public roles. `last_error` stays private: it can name rows and database messages.
create policy "Anyone can read the index status" on public.indexer_state for select to anon, authenticated using (true);
grant select (id, last_job_number, last_run_at, contract_address, network) on public.indexer_state to anon, authenticated;
