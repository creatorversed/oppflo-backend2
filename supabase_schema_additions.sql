-- Run this in Supabase SQL Editor (you already have the 5 tables + indexes + RLS)

-- 1. Add via column to jobs (for Google Jobs "via LinkedIn" etc.)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS via text;

-- 2. Cache table for jobs API (6-hour sync)
CREATE TABLE IF NOT EXISTS app_meta (
  key text PRIMARY KEY,
  value timestamptz NOT NULL
);
ALTER TABLE app_meta ENABLE ROW LEVEL SECURITY;

-- 3. Upsert function for jobs API cache refresh
CREATE OR REPLACE FUNCTION upsert_jobs_batch(jobs_json jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  j jsonb;
  loc text;
  existing_id uuid;
BEGIN
  FOR j IN SELECT * FROM jsonb_array_elements(jobs_json)
  LOOP
    loc := COALESCE(trim(j->>'location'), '');
    SELECT id INTO existing_id
    FROM jobs
    WHERE lower(title) = lower(j->>'title')
      AND lower(company) = lower(j->>'company')
      AND lower(coalesce(location, '')) = lower(coalesce(NULLIF(loc, ''), ''));
    IF existing_id IS NOT NULL THEN
      UPDATE jobs SET
        description = j->>'description',
        source_url = j->>'source_url',
        via = j->>'via',
        posted_date = (j->>'posted_date')::timestamptz,
        job_type = j->>'job_type',
        is_remote = COALESCE((j->>'is_remote')::boolean, false),
        source = COALESCE(j->>'source', 'unknown'),
        is_verified = COALESCE((j->>'is_verified')::boolean, false)
      WHERE id = existing_id;
    ELSE
      INSERT INTO jobs (
        title, company, location, description, source, source_url, via,
        is_verified, posted_date, job_type, is_remote, status
      ) VALUES (
        j->>'title',
        j->>'company',
        NULLIF(loc, ''),
        j->>'description',
        COALESCE(j->>'source', 'unknown'),
        j->>'source_url',
        j->>'via',
        COALESCE((j->>'is_verified')::boolean, false),
        (j->>'posted_date')::timestamptz,
        j->>'job_type',
        COALESCE((j->>'is_remote')::boolean, false),
        'active'
      );
    END IF;
  END LOOP;
END;
$$;
