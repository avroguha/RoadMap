-- RoadMap Studio web: initial schema.

-- Values the application generates once and every instance shares: the key
-- that signs short-lived cookies, the SAML service provider key pair, the last
-- good copy of the identity provider metadata.
CREATE TABLE app_secrets (
    name        text PRIMARY KEY,
    value       bytea NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- People are created by their first sign-in; nobody is created by hand.
CREATE TABLE users (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id  text NOT NULL UNIQUE,        -- Azure object id, or the NameID
    email        text NOT NULL DEFAULT '',
    name         text NOT NULL DEFAULT '',
    given_name   text NOT NULL DEFAULT '',
    family_name  text NOT NULL DEFAULT '',
    is_admin     boolean NOT NULL DEFAULT false,
    active       boolean NOT NULL DEFAULT true,
    settings     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_login   timestamptz
);
CREATE INDEX users_email_idx ON users (lower(email));

-- Only a hash of each session token is stored, so a copy of the database
-- cannot be used to sign in as anyone.
CREATE TABLE sessions (
    token_hash  bytea PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    last_seen   timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- One row per roadmap. `doc` is the whole roadmap as the browser knows it;
-- `rev` goes up by one with every accepted batch of edits.
CREATE TABLE roadmaps (
    id          uuid PRIMARY KEY,
    owner_id    uuid NOT NULL REFERENCES users(id),
    name        text NOT NULL DEFAULT '',
    doc         jsonb NOT NULL,
    rev         bigint NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX roadmaps_owner_idx ON roadmaps (owner_id);

-- Who else may open a roadmap. The owner is not listed here.
CREATE TABLE roadmap_members (
    roadmap_id  uuid NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        text NOT NULL CHECK (role IN ('editor', 'viewer')),
    added_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    added_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (roadmap_id, user_id)
);
CREATE INDEX roadmap_members_user_idx ON roadmap_members (user_id);

-- Every accepted batch of edits, in order. Live browsers catch up from here
-- after a reconnect; batch_id makes a resent batch harmless.
CREATE TABLE roadmap_ops (
    roadmap_id  uuid NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
    rev         bigint NOT NULL,
    batch_id    text NOT NULL,
    user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
    ops         jsonb NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (roadmap_id, rev),
    UNIQUE (roadmap_id, batch_id)
);
CREATE INDEX roadmap_ops_created_idx ON roadmap_ops (created_at);

-- Saved versions: automatic ones while people work, plus named ones.
CREATE TABLE roadmap_versions (
    id          bigserial PRIMARY KEY,
    roadmap_id  uuid NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
    rev         bigint NOT NULL,
    label       text NOT NULL DEFAULT '',
    auto        boolean NOT NULL DEFAULT false,
    items       integer NOT NULL DEFAULT 0,
    doc         jsonb NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX roadmap_versions_roadmap_idx ON roadmap_versions (roadmap_id, created_at DESC);
