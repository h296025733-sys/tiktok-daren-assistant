CREATE TABLE IF NOT EXISTS activation_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'available'
        CHECK (state IN ('available', 'bound', 'revoked')),
    created_at TEXT NOT NULL,
    device_id TEXT UNIQUE,
    device_secret_hash TEXT,
    extension_id TEXT,
    extension_version TEXT,
    bound_at TEXT,
    last_seen_at TEXT,
    revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_activation_keys_state
    ON activation_keys(state, id);
