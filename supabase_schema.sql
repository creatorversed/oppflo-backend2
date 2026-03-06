-- OppFlo: Creator economy job tracking platform
-- Run this in Supabase SQL Editor
--
-- Note: For RLS to work with Supabase Auth, ensure users.id equals auth.uid().
-- Use a trigger on auth.users (e.g. on insert, insert into public.users (id, email) values (new.id, new.email)).

-- =============================================================================
-- TABLES
-- =============================================================================

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  name text,
  tier text NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'mogul')),
  beehiiv_subscriber_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login timestamptz,
  xp_points integer NOT NULL DEFAULT 0,
  level integer NOT NULL DEFAULT 1,
  streak_days integer NOT NULL DEFAULT 0
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  company text NOT NULL,
  location text,
  description text,
  salary_min integer,
  salary_max integer,
  job_type text,
  is_remote boolean NOT NULL DEFAULT false,
  source text NOT NULL,
  source_url text,
  via text,
  is_verified boolean NOT NULL DEFAULT false,
  posted_date timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active'
);

CREATE TABLE applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  job_title text NOT NULL,
  company text NOT NULL,
  status text NOT NULL DEFAULT 'applied' CHECK (status IN ('saved', 'applied', 'interview', 'offer', 'rejected', 'ghosted')),
  applied_date timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  source_platform text
);

CREATE TABLE ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  tokens_used integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE magic_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  token text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  used boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Cache for jobs API: last time we synced from IMS/SerpAPI/YC (backend only, use service role)
CREATE TABLE app_meta (
  key text PRIMARY KEY,
  value timestamptz NOT NULL
);

-- =============================================================================
-- INDEXES
-- =============================================================================

-- users.email: already indexed via UNIQUE constraint

CREATE INDEX idx_jobs_source ON jobs(source);
CREATE INDEX idx_jobs_company ON jobs(company);
CREATE INDEX idx_jobs_title ON jobs(title);
CREATE UNIQUE INDEX idx_jobs_dedup ON jobs(
  lower(title),
  lower(company),
  lower(coalesce(location, ''))
);

CREATE INDEX idx_applications_user_id ON applications(user_id);
CREATE INDEX idx_applications_status ON applications(status);

CREATE INDEX idx_ai_usage_user_id ON ai_usage(user_id);

-- =============================================================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE magic_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_meta ENABLE ROW LEVEL SECURITY;

-- app_meta: no policies = only service role can read/write (used by jobs API cache)

-- Users: can read and update only their own row (id = auth.uid())
CREATE POLICY "Users can read own row"
  ON users FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own row"
  ON users FOR UPDATE
  USING (auth.uid() = id);

-- Allow insert for new signups (e.g. from auth hook or service role)
-- If signup creates the user row with id = auth.uid(), allow insert for own id
CREATE POLICY "Users can insert own row"
  ON users FOR INSERT
  WITH CHECK (auth.uid() = id);

-- Jobs: readable by authenticated users (public job board)
CREATE POLICY "Authenticated users can read jobs"
  ON jobs FOR SELECT
  TO authenticated
  USING (true);

-- No INSERT/UPDATE/DELETE for regular users on jobs (use service role or a separate admin policy if needed)

-- Applications: users can only see and edit their own
CREATE POLICY "Users can read own applications"
  ON applications FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own applications"
  ON applications FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own applications"
  ON applications FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own applications"
  ON applications FOR DELETE
  USING (auth.uid() = user_id);

-- AI usage: users can only see and edit their own
CREATE POLICY "Users can read own ai_usage"
  ON ai_usage FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own ai_usage"
  ON ai_usage FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own ai_usage"
  ON ai_usage FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own ai_usage"
  ON ai_usage FOR DELETE
  USING (auth.uid() = user_id);

-- Magic links: no policies for authenticated users (only service role can access)
-- This keeps tokens secret. Your auth backend uses the service role key to create/validate links.

-- =============================================================================
-- TRIGGERS (optional)
-- =============================================================================

-- Auto-update applications.updated_at on row change
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER applications_updated_at
  BEFORE UPDATE ON applications
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- JOBS API: upsert jobs by (title, company, location) for cache refresh
-- =============================================================================

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
