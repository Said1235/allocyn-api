-- The "enable RLS on new tables" project option installs public.rls_auto_enable() as SECURITY DEFINER.
-- By default every role can execute it through /rest/v1/rpc, which the security advisor flags.
-- It only needs to run as an event trigger, so nobody has to be able to call it directly.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
