import pg from 'pg';

const { Pool } = pg;

// ── Connection Pool ───────────────────────────────────────────
// Railway автоматически задаёт DATABASE_URL при добавлении
// PostgreSQL сервиса в проект.

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
    console.error('[DB] Unexpected pool error:', err.message);
});

// ── Schema Init ───────────────────────────────────────────────

export async function initSchema() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS players (
                id         SERIAL PRIMARY KEY,
                player_id  VARCHAR(128) UNIQUE NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS token_balances (
                player_id  VARCHAR(128) PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
                red        INTEGER NOT NULL DEFAULT 0,
                green      INTEGER NOT NULL DEFAULT 0,
                blue       INTEGER NOT NULL DEFAULT 0,
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS token_transactions (
                id         SERIAL PRIMARY KEY,
                player_id  VARCHAR(128) NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
                type       VARCHAR(8)   NOT NULL CHECK (type IN ('red','green','blue')),
                amount     INTEGER      NOT NULL,
                reason     VARCHAR(256) NOT NULL,
                created_at TIMESTAMPTZ  DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS player_profiles (
                player_id        VARCHAR(128) PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
                hours_played     FLOAT   NOT NULL DEFAULT 0,
                anomaly_interest FLOAT   NOT NULL DEFAULT 0,
                query_style      FLOAT   NOT NULL DEFAULT 0,
                room_preference  VARCHAR(64) DEFAULT 'hub',
                updated_at       TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_transactions_player
                ON token_transactions(player_id, created_at DESC);
        `);
        console.log('[DB] Schema initialised.');
    } finally {
        client.release();
    }
}

// ── Player ────────────────────────────────────────────────────

export async function ensurePlayer(playerId) {
    await pool.query(`
        INSERT INTO players (player_id) VALUES ($1)
        ON CONFLICT (player_id) DO NOTHING
    `, [playerId]);

    await pool.query(`
        INSERT INTO token_balances (player_id) VALUES ($1)
        ON CONFLICT (player_id) DO NOTHING
    `, [playerId]);

    await pool.query(`
        INSERT INTO player_profiles (player_id) VALUES ($1)
        ON CONFLICT (player_id) DO NOTHING
    `, [playerId]);
}

// ── Token Balances ────────────────────────────────────────────

export async function getBalance(playerId) {
    const res = await pool.query(
        'SELECT red, green, blue FROM token_balances WHERE player_id = $1',
        [playerId]
    );
    return res.rows[0] ?? { red: 0, green: 0, blue: 0 };
}

/**
 * Атомарное изменение баланса.
 * delta > 0 = начисление, delta < 0 = списание.
 * Возвращает новый баланс или бросает Error если баланс уйдёт в минус.
 */
export async function changeBalance(playerId, type, delta, reason) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Блокируем строку для атомарности
        const lockRes = await client.query(
            'SELECT red, green, blue FROM token_balances WHERE player_id = $1 FOR UPDATE',
            [playerId]
        );

        if (lockRes.rows.length === 0) {
            throw new Error(`Player '${playerId}' not found.`);
        }

        const current = lockRes.rows[0][type];
        const newValue = current + delta;

        if (newValue < 0) {
            throw new InsufficientTokensError(type, Math.abs(delta), current);
        }

        // Обновляем баланс
        await client.query(
            `UPDATE token_balances
             SET ${type} = $1, updated_at = NOW()
             WHERE player_id = $2`,
            [newValue, playerId]
        );

        // Записываем транзакцию
        await client.query(
            'INSERT INTO token_transactions (player_id, type, amount, reason) VALUES ($1,$2,$3,$4)',
            [playerId, type, delta, reason]
        );

        await client.query('COMMIT');

        // Возвращаем полный новый баланс
        const balRes = await client.query(
            'SELECT red, green, blue FROM token_balances WHERE player_id = $1',
            [playerId]
        );
        return balRes.rows[0];

    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// ── Player Profile ────────────────────────────────────────────

export async function getProfile(playerId) {
    const res = await pool.query(
        'SELECT * FROM player_profiles WHERE player_id = $1',
        [playerId]
    );
    return res.rows[0] ?? null;
}

export async function upsertProfile(playerId, profile) {
    await pool.query(`
        INSERT INTO player_profiles
            (player_id, hours_played, anomaly_interest, query_style, room_preference, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (player_id) DO UPDATE SET
            hours_played     = EXCLUDED.hours_played,
            anomaly_interest = EXCLUDED.anomaly_interest,
            query_style      = EXCLUDED.query_style,
            room_preference  = EXCLUDED.room_preference,
            updated_at       = NOW()
    `, [
        playerId,
        profile.hoursPlayed     ?? 0,
        profile.anomalyInterest ?? 0,
        profile.queryStyle      ?? 0,
        profile.roomPreference  ?? 'hub',
    ]);
}

// ── Custom Errors ─────────────────────────────────────────────

export class InsufficientTokensError extends Error {
    constructor(type, required, current) {
        super(`Insufficient ${type} tokens: required ${required}, have ${current}`);
        this.name = 'InsufficientTokensError';
        this.type = type;
        this.required = required;
        this.current = current;
    }
}

export default pool;