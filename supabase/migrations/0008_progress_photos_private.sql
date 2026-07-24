-- ============================================================================
-- Migration 0008 — Make the `progress-photos` bucket PRIVATE + owner-only RLS.
--                   Security fix; see ADR-014 / Known Issues #1.
-- ----------------------------------------------------------------------------
-- WHY THIS EXISTS
--   The 2026-07-18 second auth audit proved (adversarially) that the
--   `progress-photos` Storage bucket was `public = true` AND anon could LIST it:
--     • anon could enumerate every object (`/object/list/progress-photos`), and
--     • read any object via its public URL (`/object/public/progress-photos/…`),
--     • and one authenticated user could read another's objects.
--   Progress (physique) photos are personal data → this was an unauthenticated
--   read + enumeration exposure (HIGH). The app uploaded to a FLAT namespace
--   (`photo_<ts>_<rand>.jpg`) and rendered via getPublicUrl, so nothing scoped
--   access to the owner. Migration 0003 never covered Storage (see [[ADR-004]]).
--
-- WHAT THIS DOES (progress-photos ONLY — the public `exercises` catalog bucket,
-- intentionally public for GIFs, is untouched)
--   • prints the BEFORE state (bucket public flags + every storage.objects
--     policy) for the audit trail;
--   • sets the bucket `public = false` (kills the anon public-URL read path);
--   • drops any storage.objects policy that explicitly targets 'progress-photos'
--     (name-agnostic; a legacy dashboard "public access" policy is replaced);
--   • creates owner-only RLS: select/insert/update/delete require
--     `bucket_id = 'progress-photos' AND owner = auth.uid()`;
--   • prints the AFTER state and RAISEs if the bucket is still public. Any
--     BUCKET-AGNOSTIC permissive policy (USING true, no bucket filter) is NOT
--     dropped here — it would affect other buckets — but IS surfaced in the
--     NOTICE dump for manual review, and the post-migration live audit is the
--     final arbiter.
--
-- PAIRS WITH A CODE CHANGE (deploy the code FIRST, then run this — zero downtime)
--   js/gym/gym-ui.js now stores the object PATH (not a public URL) and renders
--   via short-lived createSignedUrl(). Signed URLs work on a public bucket too,
--   so shipping the code before this migration never breaks display; flipping
--   the bucket private afterwards then closes the hole with no window.
--
-- SAFETY: idempotent (guarded); no object data is touched. Run once in:
--   Supabase → SQL Editor.
-- ============================================================================

-- ---------- 0. BEFORE snapshot ----------------------------------------------
do $$
declare b record; pol record; n int := 0;
begin
  for b in select id, public from storage.buckets loop
    raise notice '[0008] BEFORE bucket %: public=%', b.id, b.public;
  end loop;
  for pol in select policyname, cmd, roles, qual, with_check
             from pg_policies where schemaname='storage' and tablename='objects' order by policyname loop
    n := n + 1;
    raise notice '[0008] BEFORE storage.objects policy %: cmd=% roles=% using=% check=%',
      pol.policyname, pol.cmd, pol.roles, coalesce(pol.qual,'<none>'), coalesce(pol.with_check,'<none>');
  end loop;
  raise notice '[0008] BEFORE: % storage.objects policy(ies)', n;
end $$;

-- ---------- 1. bucket → private ---------------------------------------------
update storage.buckets set public = false where id = 'progress-photos';

-- ---------- 2. drop progress-photos-specific policies (name-agnostic) --------
-- Only policies whose definition references this bucket are dropped, so
-- bucket-agnostic policies (which could serve other buckets) are left intact.
do $$
declare pol record;
begin
  for pol in select policyname from pg_policies
             where schemaname='storage' and tablename='objects'
               and (coalesce(qual,'') || coalesce(with_check,'')) like '%progress-photos%'
  loop
    execute format('drop policy if exists %I on storage.objects', pol.policyname);
    raise notice '[0008] dropped storage.objects policy % (referenced progress-photos)', pol.policyname;
  end loop;
end $$;

-- ---------- 3. owner-only RLS for progress-photos ---------------------------
drop policy if exists "progress-photos owner read"   on storage.objects;
drop policy if exists "progress-photos owner insert" on storage.objects;
drop policy if exists "progress-photos owner update" on storage.objects;
drop policy if exists "progress-photos owner delete" on storage.objects;

create policy "progress-photos owner read" on storage.objects
  for select to authenticated
  using (bucket_id = 'progress-photos' and owner = auth.uid());

create policy "progress-photos owner insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'progress-photos' and owner = auth.uid());

create policy "progress-photos owner update" on storage.objects
  for update to authenticated
  using (bucket_id = 'progress-photos' and owner = auth.uid())
  with check (bucket_id = 'progress-photos' and owner = auth.uid());

create policy "progress-photos owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'progress-photos' and owner = auth.uid());

-- ---------- 4. AFTER verification -------------------------------------------
do $$
declare is_pub boolean; ownerpols int; agnostic int;
begin
  select public into is_pub from storage.buckets where id='progress-photos';
  if coalesce(is_pub, true) then
    raise exception '[0008] POST-CHECK FAILED: progress-photos is still public';
  end if;
  select count(*) into ownerpols from pg_policies
    where schemaname='storage' and tablename='objects' and policyname like 'progress-photos owner %';
  -- Flag any remaining bucket-agnostic policy that could still expose the bucket.
  select count(*) into agnostic from pg_policies
    where schemaname='storage' and tablename='objects'
      and (coalesce(qual,'')||coalesce(with_check,'')) not like '%bucket_id%';
  raise notice '[0008] AFTER: progress-photos public=% | owner policies=% | bucket-agnostic policies=% (review if >0)',
    is_pub, ownerpols, agnostic;
  if ownerpols <> 4 then
    raise exception '[0008] POST-CHECK FAILED: expected 4 owner policies, found %', ownerpols;
  end if;
  raise notice '[0008] OK — progress-photos is private + owner-only. Verify with the live audit (anon/cross-user read must fail).';
end $$;
