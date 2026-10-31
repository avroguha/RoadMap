-- A local administrator account next to single sign-on: user "admin",
-- seeded at start-up with the password "admin" (see local.go). Only this
-- account has a password; everyone else signs in through the identity provider.
ALTER TABLE users
    ADD COLUMN username             text UNIQUE,                -- only local accounts have one
    ADD COLUMN password_hash        text NOT NULL DEFAULT '',   -- pbkdf2-sha256$iter$salt$hash
    ADD COLUMN password_is_default  boolean NOT NULL DEFAULT false,
    ADD COLUMN password_changed_at  timestamptz;
