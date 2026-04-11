import fetch from 'node-fetch';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ── System Prompts ────────────────────────────────────────────

/**
 * Собирает три system-блока из архдока + историю + вопрос пользователя.
 * system[0]: роль AI базы
 * system[1]: профиль оператора (из PlayerProfile)
 * system[2]: контекст объекта (sensorData из ScannableObjectSO)
 */
function buildMessages(objectData, playerProfile, history) {
    const messages = [];

    // system[0] — роль AI
    messages.push({
        role: 'system',
        content:
            'You are the automated scanning database of an isolated research base. ' +
            'Respond in the same language as the user\'s question. ' +
            'Be neutral, concise, and clinical. Report only what sensors detect. ' +
            'Do not speculate beyond sensor data. Maximum 3 sentences per response. ' +
            'Never break character.'
    });

    // system[1] — профиль оператора
    if (playerProfile) {
        const interestLevel = playerProfile.anomaly_interest > 0.6
            ? 'high anomaly interest'
            : playerProfile.anomaly_interest > 0.3
                ? 'moderate curiosity'
                : 'routine operational focus';

        const queryStyleDesc = playerProfile.query_style > 0.6
            ? 'detailed and investigative'
            : 'brief and practical';

        messages.push({
            role: 'system',
            content:
                `Operator profile: ${Math.round(playerProfile.hours_played)}h on base. ` +
                `Interest profile: ${interestLevel}. ` +
                `Query style: ${queryStyleDesc}. ` +
                `Frequent location: ${playerProfile.room_preference ?? 'hub'}. ` +
                `Adjust detail level accordingly without breaking clinical tone.`
        });
    }

    // system[2] — контекст объекта
    if (objectData) {
        messages.push({
            role: 'system',
            content:
                `Object ID: ${objectData.objectId}. ` +
                `Sensor readings: ${objectData.sensorData ?? 'no data'}. ` +
                `Classification: ${objectData.objectType ?? 'unknown'}.`
        });
    }

    // История диалога из ScanSession
    for (const msg of (history ?? [])) {
        messages.push({ role: msg.role, content: msg.content });
    }

    return messages;
}

// ── Main Request ──────────────────────────────────────────────

/**
 * Отправляет запрос в Groq API.
 * @param {object} params
 * @param {object} params.objectData    — { objectId, sensorData, objectType }
 * @param {object} params.playerProfile — строка из player_profiles или null
 * @param {Array}  params.history       — массив { role, content }
 * @returns {Promise<string>} текст ответа
 */
export async function queryGroq({ objectData, playerProfile, history }) {
    const messages = buildMessages(objectData, playerProfile, history);

    const body = {
        model:       process.env.GROQ_MODEL ?? 'llama-3.1-8b-instant',
        messages,
        max_tokens:  256,
        temperature: 0.4,  // Низкая температура для клинического тона
        stream:      false,
    };

    const response = await fetch(GROQ_API_URL, {
        method:  'POST',
        headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12000),  // 12s timeout
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Groq API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;

    if (!content) {
        throw new Error('Groq API returned empty content.');
    }

    return content.trim();
}