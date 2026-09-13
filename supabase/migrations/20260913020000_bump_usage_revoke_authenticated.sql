-- Supabase auto-grants EXECUTE on new functions to `authenticated` by
-- default; the original migration only revoked from `public, anon` and
-- missed this, letting any logged-in user call bump_usage() directly
-- with an arbitrary p_user to grief another user's daily usage count.
-- Only the ai-proxy Edge Function (using the service role) should ever
-- call this.
revoke execute on function public.bump_usage(uuid, date, int) from authenticated;
