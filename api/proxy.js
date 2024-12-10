const API_KEYS = (process.env.API_KEYS || '').split(',').filter(key => key.trim());
const BASE_URL = process.env.BASE_URL || 'https://api.openai.com';

let currentKeyIndex = 0;

async function handleStream(response, res) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let done = false;

    while (!done) {
        const { value, done: streamDone } = await reader.read();
        done = streamDone;
        if (value) {
            const chunk = decoder.decode(value, { stream: true });
            res.write(chunk);
        }
    }

    res.end();
}

async function handleNonStream(response, res) {
    const data = await response.json();
    res.status(response.status).json(data);
}

async function proxyRequest(req, res, apiKey) {
    const path = req.url.replace('/v1/', '');
    const targetUrl = `${BASE_URL}/v1/${path}`;

    const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': req.headers['content-type'] || 'application/json',
    };

    let body = null;
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        if (typeof req.body === 'string') {
            body = req.body;
        } else if (Buffer.isBuffer(req.body)) {
            body = req.body.toString();
        } else if (typeof req.body === 'object') {
            body = JSON.stringify(req.body);
        }
    }

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: headers,
            body: body,
        });

        // 转发响应头
        for (const [key, value] of response.headers.entries()) {
            res.setHeader(key, value);
        }

        // 检查内容类型并相应处理
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('text/event-stream')) {
            return handleStream(response, res);
        } else {
            return handleNonStream(response, res);
        }
    } catch (error) {
        console.error('Proxy error:', error);
        throw error;
    }
}

module.exports = async (req, res) => {
    // 添加CORS头
    res.setHeader('Access-Control-Allow-Origin', '*');*
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // 处理 OPTIONS 请求
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (!API_KEYS.length) {
        return res.status(500).json({
            error: {
                message: "API_KEYS environment variable is not set or is empty",
                type: "config_error",
                param: "API_KEYS",
                code: "missing_api_keys"
            }
        });
    }

    let retries = 0;
    const maxRetries = API_KEYS.length;

    while (retries < maxRetries) {
        const apiKey = API_KEYS[currentKeyIndex];
        currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;

        try {
            await proxyRequest(req, res, apiKey);
            return;
        } catch (error) {
            retries++;
            console.warn(`Request failed with key ${apiKey}, retrying... (${retries}/${maxRetries})`);
            if (retries < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
    }

    return res.status(500).json({
        error: {
            message: "All API keys failed",
            type: "api_error",
            param: null,
            code: "all_keys_failed"
        }
    });
};
