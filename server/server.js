import 'dotenv/config';
import express        from 'express';
import cors           from 'cors';
import rateLimit      from 'express-rate-limit';
import { queryGroq }  from './groq.js';
import {
    initSchema,
    ensurePlayer,
    getBalance,
    changeBalance,
    getProfile,
    upsertProfile,
    InsufficientTokensError,
} from './db.js';

const app  = express();
const PORT = process.env.PORT ?? 3000;

// ── Middleware ────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '64kb' }));

// Rate limiting: макс 10 запросов в минуту на IP
// В продакшене заменить IP на playerId из тела запроса
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000'),
    max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS ?? '10'),
    standardHeaders: true,
    legacyHeaders:   false,
    message: { error: 'Too many requests. Slow down.' },
});
app.use('/tokens', limiter);
app.use('/scan',   limiter);

// ── Health Check ──────────────────────────────────────────────

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Tokens: GET /tokens/:playerId ─────────────────────────────
// Возвращает текущий баланс всех трёх типов токенов.

app.get('/tokens/:playerId', async (req, res) => {
    const { playerId } = req.params;

    try {
        await ensurePlayer(playerId);
        const balance = await getBalance(playerId);
        res.json({ playerId, ...balance });
    } catch (err) {
        console.error('[GET /tokens] Error:', err.message);
        res.status(500).json({ error: 'Failed to fetch balance.' });
    }
});

// ── Tokens: POST /tokens/:playerId/earn ───────────────────────
// Начисляет токены. Body: { type: "red"|"green"|"blue", amount: int, source: string }

app.post('/tokens/:playerId/earn', async (req, res) => {
    const { playerId } = req.params;
    const { type, amount, source } = req.body;

    const validationError = validateTokenRequest(type, amount);
    if (validationError) return res.status(400).json({ error: validationError });

    try {
        await ensurePlayer(playerId);
        const newBalance = await changeBalance(
            playerId, type, Math.abs(amount), source ?? 'earn'
        );
        res.json({ playerId, delta: amount, ...newBalance });
    } catch (err) {
        console.error('[POST /tokens/earn] Error:', err.message);
        res.status(500).json({ error: 'Failed to earn tokens.' });
    }
});

// ── Tokens: POST /tokens/:playerId/spend ──────────────────────
// Списывает токены. Body: { type: "red"|"green"|"blue", amount: int, reason: string }
// Сервер проверяет что баланс >= amount перед списанием.

app.post('/tokens/:playerId/spend', async (req, res) => {
    const { playerId } = req.params;
    const { type, amount, reason } = req.body;

    const validationError = validateTokenRequest(type, amount);
    if (validationError) return res.status(400).json({ error: validationError });

    try {
        await ensurePlayer(playerId);
        const newBalance = await changeBalance(
            playerId, type, -Math.abs(amount), reason ?? 'spend'
        );
        res.json({ playerId, delta: -amount, ...newBalance });
    } catch (err) {
        if (err instanceof InsufficientTokensError) {
            return res.status(402).json({
                error:    'Insufficient tokens.',
                type:     err.type,
                required: err.required,
                current:  err.current,
            });
        }
        console.error('[POST /tokens/spend] Error:', err.message);
        res.status(500).json({ error: 'Failed to spend tokens.' });
    }
});

// ── Scan: POST /scan ──────────────────────────────────────────
// Groq proxy. Проверяет токены, шлёт в Groq, возвращает ответ.
// Body: { playerId, objectId, messages: [{role, content}], isPrimary: bool }
// Объектные данные (sensorData) хранятся на сервере или передаются клиентом.
// Для Этапа 1: клиент передаёт objectId, сервер отдаёт ответ Groq.

app.post('/scan', async (req, res) => {
    const { playerId, objectId, messages, isPrimary } = req.body;

    if (!playerId || !objectId || !Array.isArray(messages)) {
        return res.status(400).json({
            error: 'Required fields: playerId, objectId, messages[]'
        });
    }

    try {
        await ensurePlayer(playerId);

        // Проверяем и списываем токены
        const costRed   = isPrimary ? 1 : 2;
        const costGreen = isPrimary ? 0 : 1;

        const balance = await getBalance(playerId);

        if (balance.red < costRed) {
            return res.status(402).json({
                error:    'Insufficient red tokens.',
                type:     'red',
                required: costRed,
                current:  balance.red,
            });
        }

        if (costGreen > 0 && balance.green < costGreen) {
            return res.status(402).json({
                error:    'Insufficient green tokens.',
                type:     'green',
                required: costGreen,
                current:  balance.green,
            });
        }

        // Получаем профиль игрока для инжекции в промпт
        const profile = await getProfile(playerId);

        // Запрос к Groq
        const responseText = await queryGroq({
            objectData:    { objectId, sensorData: null, objectType: null },
            playerProfile: profile,
            history:       messages,
        });

        // Списываем красные токены
        await changeBalance(playerId, 'red',   -costRed,   `scan:${objectId}`);
        if (costGreen > 0) {
            await changeBalance(playerId, 'green', -costGreen, `scan:${objectId}`);
        }

        // Начисляем синие токены
        const blueReward = isPrimary ? 3 : 1;
        const newBalance = await changeBalance(
            playerId, 'blue', blueReward, `scan_reward:${objectId}`
        );

        res.json({
            response:          responseText,
            blueTokensAwarded: blueReward,
            balance:           newBalance,
        });

    } catch (err) {
        console.error('[POST /scan] Error:', err.message);

        if (err.name === 'AbortError') {
            return res.status(504).json({ error: 'Groq API timeout.' });
        }

        res.status(500).json({ error: 'Scan request failed.' });
    }
});

// ── Profile: PUT /profile/:playerId ───────────────────────────
// Синхронизация PlayerProfile из Unity клиента.
// Body: { hoursPlayed, anomalyInterest, queryStyle, roomPreference }

app.put('/profile/:playerId', async (req, res) => {
    const { playerId } = req.params;
    const profile = req.body;

    if (!profile || typeof profile !== 'object') {
        return res.status(400).json({ error: 'Profile object required in body.' });
    }

    try {
        await ensurePlayer(playerId);
        await upsertProfile(playerId, profile);
        res.json({ ok: true, playerId });
    } catch (err) {
        console.error('[PUT /profile] Error:', err.message);
        res.status(500).json({ error: 'Failed to update profile.' });
    }
});

// ── Helpers ───────────────────────────────────────────────────

function validateTokenRequest(type, amount) {
    if (!['red', 'green', 'blue'].includes(type)) {
        return `Invalid token type '${type}'. Must be: red, green, blue.`;
    }
    if (!Number.isInteger(amount) || amount <= 0) {
        return `Amount must be a positive integer, got: ${amount}`;
    }
    return null;
}

// ── 404 ───────────────────────────────────────────────────────

app.use((_req, res) => {
    res.status(404).json({ error: 'Endpoint not found.' });
});

// ── Start ─────────────────────────────────────────────────────

async function start() {
    try {
        await initSchema();
        app.listen(PORT, () => {
            console.log(`[Server] АРХИПЕЛАГ server running on port ${PORT}`);
            console.log(`[Server] Groq model: ${process.env.GROQ_MODEL ?? 'llama-3.1-8b-instant'}`);
            console.log(`[Server] Environment: ${process.env.NODE_ENV ?? 'development'}`);
        });
    } catch (err) {
        console.error('[Server] Failed to start:', err.message);
        process.exit(1);
    }
}

start();