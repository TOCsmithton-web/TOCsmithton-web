-- TOC Smithton Control: Supabase security for central settings
-- Run this once in the Supabase SQL Editor.

-- Ensure the single central settings row exists.
INSERT INTO public.control_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- Public users may read the central settings.
DROP POLICY IF EXISTS "control_settings_public_read" ON public.control_settings;
CREATE POLICY "control_settings_public_read"
ON public.control_settings
FOR SELECT
TO anon, authenticated
USING (true);

-- Only users listed in admin_users may change central settings.
DROP POLICY IF EXISTS "control_settings_admin_update" ON public.control_settings;
CREATE POLICY "control_settings_admin_update"
ON public.control_settings
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.admin_users
    WHERE admin_users.user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.admin_users
    WHERE admin_users.user_id = auth.uid()
  )
);

-- Do not allow browser users to insert or delete central settings.
DROP POLICY IF EXISTS "control_settings_no_insert" ON public.control_settings;
DROP POLICY IF EXISTS "control_settings_no_delete" ON public.control_settings;
