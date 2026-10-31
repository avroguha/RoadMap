-- Change history. Every accepted batch of edits already has who and when
-- (roadmap_ops); from now on it also carries what changed, in words the
-- history page can show without replaying anything: the fields, their old
-- and new values, and the names of the items as they were at the time.
-- Batches are kept for as long as the roadmap exists.
ALTER TABLE roadmap_ops ADD COLUMN summary jsonb;

-- Things that happen to a roadmap outside its contents: shared, unshared,
-- handed over, a version saved, a comment removed by the owner.
CREATE TABLE roadmap_events (
    id          bigserial PRIMARY KEY,
    roadmap_id  uuid NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
    user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
    kind        text NOT NULL,
    detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX roadmap_events_rm_idx ON roadmap_events (roadmap_id, created_at DESC);
