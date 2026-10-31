package main

import (
	"context"
	"crypto/rand"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// migrationLock is the advisory lock every instance takes before migrating
// or generating shared secrets, so two containers starting on a fresh
// database never race on the catalog or mint two different keys.
const migrationLock = 7_201_312

func connectDB(ctx context.Context, c *config) (*pgxpool.Pool, error) {
	dsn := c.DatabaseURL
	if c.DBPasswordFile != "" {
		pw, err := os.ReadFile(c.DBPasswordFile)
		if err != nil {
			return nil, fmt.Errorf("reading the database password from %s: %w", c.DBPasswordFile, err)
		}
		u, err := url.Parse(dsn)
		if err != nil {
			return nil, fmt.Errorf("RMS_DATABASE_URL: %w", err)
		}
		user := "roadmap"
		if u.User != nil && u.User.Username() != "" {
			user = u.User.Username()
		}
		u.User = url.UserPassword(user, strings.TrimSpace(string(pw)))
		dsn = u.String()
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("RMS_DATABASE_URL: %w", err)
	}
	cfg.MaxConns = 20
	// Nothing may hold a roadmap's row lock, or any lock, for long: a stuck
	// transaction would otherwise stall every editor of that roadmap. A batch
	// that cannot get the lock within 5 s fails fast and the browser retries.
	cfg.ConnConfig.RuntimeParams["application_name"] = "roadmap-studio"
	cfg.ConnConfig.RuntimeParams["lock_timeout"] = "5000"
	cfg.ConnConfig.RuntimeParams["statement_timeout"] = "30000"
	cfg.ConnConfig.RuntimeParams["idle_in_transaction_session_timeout"] = "30000"

	// After a host reboot the app may start before Postgres accepts
	// connections: wait for it instead of crash-looping.
	deadline := time.Now().Add(c.DBWait)
	for attempt := 1; ; attempt++ {
		pool, err := pgxpool.NewWithConfig(ctx, cfg)
		if err == nil {
			if err = pool.Ping(ctx); err == nil {
				return pool, nil
			}
			pool.Close()
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("database %s not reachable after %s: %w", cfg.ConnConfig.Host, c.DBWait, err)
		}
		if attempt == 1 || attempt%10 == 0 {
			log.Printf("waiting for the database at %s:%d: %v", cfg.ConnConfig.Host, cfg.ConnConfig.Port, err)
		}
		time.Sleep(2 * time.Second)
	}
}

// migrate applies every embedded migration not yet recorded, in order, under
// the advisory lock.
func migrate(ctx context.Context, db *pgxpool.Pool) error {
	conn, err := db.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	// Several containers starting together queue here; waiting is correct.
	conn.Exec(ctx, "SET lock_timeout = 0")
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", migrationLock); err != nil {
		return err
	}
	defer conn.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", migrationLock)

	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	names, err := fs.Glob(migrationFiles, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)
	for _, name := range names {
		base := strings.TrimPrefix(name, "migrations/")
		version, err := strconv.Atoi(strings.SplitN(base, "_", 2)[0])
		if err != nil {
			return fmt.Errorf("migration %s: name must start with a number", base)
		}
		var done bool
		if err := conn.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version=$1)", version).Scan(&done); err != nil {
			return err
		}
		if done {
			continue
		}
		sql, _ := migrationFiles.ReadFile(name)
		tx, err := conn.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("migration %s: %w", base, err)
		}
		if _, err := tx.Exec(ctx, "INSERT INTO schema_migrations (version) VALUES ($1)", version); err != nil {
			tx.Rollback(ctx)
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		log.Printf("database: applied migration %s", base)
	}
	return nil
}

// sharedSecret returns the named secret, generating it with gen the first
// time. Under the advisory lock, so every instance ends up with the same value.
func sharedSecret(ctx context.Context, db *pgxpool.Pool, name string, gen func() ([]byte, error)) ([]byte, error) {
	var v []byte
	err := db.QueryRow(ctx, "SELECT value FROM app_secrets WHERE name=$1", name).Scan(&v)
	if err == nil {
		return v, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	conn, err := db.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()
	conn.Exec(ctx, "SET lock_timeout = 0")
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", migrationLock); err != nil {
		return nil, err
	}
	defer conn.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", migrationLock)
	if err := conn.QueryRow(ctx, "SELECT value FROM app_secrets WHERE name=$1", name).Scan(&v); err == nil {
		return v, nil
	}
	if v, err = gen(); err != nil {
		return nil, err
	}
	_, err = conn.Exec(ctx, "INSERT INTO app_secrets (name, value) VALUES ($1, $2)", name, v)
	return v, err
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

// housekeeping trims what grows without bound. Runs on every instance; each
// statement is idempotent, so overlapping runs are harmless.
func housekeeping(ctx context.Context, db *pgxpool.Pool) {
	stmts := []string{
		"DELETE FROM sessions WHERE expires_at < now()",
		// The edit log only exists so live browsers can catch up after a short
		// disconnect; versions are the long-term history.
		// Automatic versions: keep the newest 300 per roadmap. Named ones stay.
		`DELETE FROM roadmap_versions v WHERE auto AND id NOT IN (
			SELECT id FROM roadmap_versions w WHERE w.roadmap_id = v.roadmap_id AND w.auto
			ORDER BY created_at DESC LIMIT 300)`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(ctx, s); err != nil && ctx.Err() == nil {
			log.Printf("housekeeping: %v", err)
		}
	}
}
