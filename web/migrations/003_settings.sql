-- Settings an administrator changes from the app (single sign-on, access
-- rules). One row per key; the value is JSON. Instances learn of a change
-- through NOTIFY rms_settings.
CREATE TABLE app_settings (
    key         text PRIMARY KEY,
    value       jsonb NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
