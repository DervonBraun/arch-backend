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
app.set('trust proxy', 1);
const PORT = process.env.PORT ?? 3000;

// ── Middleware ────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '64kb' }));

const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS     ?? '60000'),
    max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS  ?? '10'),
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
//
// Body: {
//   playerId:            string,
//   objectId:            string,            — основной объект (legacy фоллбэк)
//   objectIds:           string[],          — все прикреплённые объекты
//   messages:            [{role, content}], — история ScanSession
//   isPrimary:           bool,              — true = первый запрос в сессии
//   questionText:        string,            — текст вопроса (для подсчёта символов)
//   playerProfile:       string,            — строка из PlayerProfileTracker.BuildProfileString() (Этап 5)
// }
//
// Формула стоимости (архдок v1.1):
//   red   = attachedCount × 500 + countNonWhitespace(questionText) × 1
//   green = isPrimary ? 1000 : 0

app.post('/scan', async (req, res) => {
    const {
        playerId,
        objectId,
        objectIds,
        messages,
        isPrimary,
        questionText,
        playerProfile: playerProfileString,  // строка из Unity PlayerProfileTracker
    } = req.body;

    if (!playerId || (!objectId && (!Array.isArray(objectIds) || objectIds.length === 0)) || !Array.isArray(messages)) {
        return res.status(400).json({
            error: 'Required fields: playerId, objectId or objectIds[], messages[]',
        });
    }

    const attachedIds   = Array.isArray(objectIds) && objectIds.length > 0
        ? objectIds
        : [objectId];
    const attachedCount = attachedIds.length;
    const charCount     = countNonWhitespace(questionText ?? '');

    const COST_PER_OBJECT  = 500;
    const COST_PER_CHAR    = 1;
    const COST_FIRST_GREEN = 1000;

    const costRed   = attachedCount * COST_PER_OBJECT + charCount * COST_PER_CHAR;
    const costGreen = isPrimary ? COST_FIRST_GREEN : 0;

    try {
        await ensurePlayer(playerId);

        const balance = await getBalance(playerId);

        if (costRed > 0 && balance.red < costRed) {
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

        // Профиль из Supabase — используется как фоллбэк если Unity не прислал строку
        const supabaseProfile = await getProfile(playerId);

        // Запрос к Groq
        // playerProfileString (из Unity) имеет приоритет над supabaseProfile
        const rawResponse = await queryGroq({
            objectData:          attachedIds.map(id => ({
                objectId:   id,
                sensorData: null,   // TODO: sensorData из ScannableObjectSO когда будет в запросе
                objectType: null,
            })),
            playerProfile:       supabaseProfile,
            history:             messages,
            flagState:           null,            // TODO: передавать из FlagService когда добавишь синхронизацию флагов на сервер
            playerProfileString: playerProfileString ?? null,
        });

        // Парсим JSON envelope { flags, tone, text }
        const parsed    = parseGroqEnvelope(rawResponse);
        const flags     = parsed.flags  ?? [];
        const tone      = parsed.tone   ?? 'neutral';
        const cleanText = applyFlagModifiers(parsed.text ?? rawResponse, flags);

        // Списываем токены после успешного ответа
        if (costRed > 0) {
            await changeBalance(playerId, 'red',   -costRed,   `scan:${objectId ?? attachedIds[0]}`);
        }
        if (costGreen > 0) {
            await changeBalance(playerId, 'green', -costGreen, `scan_init:${objectId ?? attachedIds[0]}`);
        }

        // Синие токены за сканирование
        const blueReward = isPrimary ? 3 : 1;
        const newBalance = await changeBalance(
            playerId, 'blue', blueReward, `scan_reward:${objectId ?? attachedIds[0]}`
        );

        res.json({
            response:          cleanText,
            flags,
            tone,
            blueTokensAwarded: blueReward,
            costRed,
            costGreen,
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

function countNonWhitespace(text) {
    if (!text) return 0;
    let count = 0;
    for (const ch of text) {
        if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') count++;
    }
    return count;
}

function parseGroqEnvelope(raw) {
    try {
        const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        const parsed  = JSON.parse(cleaned);
        return {
            flags: Array.isArray(parsed.flags) ? parsed.flags : [],
            tone:  typeof parsed.tone === 'string' ? parsed.tone : 'neutral',
            text:  typeof parsed.text === 'string' ? parsed.text : raw,
        };
    } catch {
        return { flags: [], tone: 'neutral', text: raw };
    }
}

/**
 * Применяет серверные модификаторы на основе флагов из ответа модели.
 * ABUSE в текущем ответе: аппендит системное предупреждение если накопилось >= 2.
 *
 * LIMITATION: счётчик ABUSE здесь считается только по текущему ответу (1 или 0).
 * Полная прогрессия (1→cold, 2→warning, 3→block) реализована на клиенте
 * в FlagService. Сервер добавляет предупреждение эвристически.
 */
function applyFlagModifiers(text, flags) {
    const hasAbuse = flags.includes('ABUSE');
    if (hasAbuse) {
        return text + '\n\n' +
            'ВНИМАНИЕ! ЗЛОУПОТРЕБЛЕНИЕ ФУНКЦИЯМИ AI МОЖЕТ ПРИВЕСТИ К БЛОКИРОВКЕ ' +
            'УЧЁТНОЙ ЗАПИСИ СЛУЖБОЙ БЕЗОПАСНОСТИ. КАЖДЫЙ ТАКОЙ ПОМЕЧЕННЫЙ ДИАЛОГ ' +
            'ПРОСМАТРИВАЕТСЯ ЧЕЛОВЕКОМ.';
    }
    return text;
}

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
