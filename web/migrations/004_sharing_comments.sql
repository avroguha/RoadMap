-- Sharing: a third role, "commenter" (sees everything, may only add comments),
-- and sharing with everyone in the organisation at a chosen role.
ALTER TABLE roadmap_members DROP CONSTRAINT roadmap_members_role_check;
ALTER TABLE roadmap_members ADD CONSTRAINT roadmap_members_role_check CHECK (role IN ('editor', 'commenter', 'viewer'));
ALTER TABLE roadmaps ADD COLUMN everyone_role text NOT NULL DEFAULT ''
    CHECK (everyone_role IN ('', 'viewer', 'commenter', 'editor'));
CREATE INDEX roadmaps_everyone_idx ON roadmaps (everyone_role) WHERE everyone_role <> '';

-- Comments on a task or milestone. Never drawn on exports; the owner (or the
-- author) can remove one, which keeps the row for the audit trail.
CREATE TABLE roadmap_comments (
    id           bigserial PRIMARY KEY,
    roadmap_id   uuid NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
    item_id      text NOT NULL,
    user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
    body         text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    resolved_at  timestamptz,
    resolved_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    deleted_at   timestamptz,
    deleted_by   uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX roadmap_comments_live_idx ON roadmap_comments (roadmap_id, item_id) WHERE deleted_at IS NULL;
