const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

export function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function cleanString(value) {
    if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) return '';
    return value.trim();
}

export function normalizeModels(response) {
    const candidates = [response, response?.data?.data, response?.data, response?.models];
    const models = candidates.find(Array.isArray) ?? [];
    const unique = new Map();
    for (const model of models) {
        const id = typeof model === 'string' ? cleanString(model)
            : isRecord(model) ? cleanString(model.id) || cleanString(model.name) : '';
        if (!id || unique.has(id)) continue;
        const name = cleanString(model?.info?.name) || cleanString(model?.display_name)
            || cleanString(model?.name) || id;
        unique.set(id, { id, name });
    }
    return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function normalizeCustomBaseUrl(value) {
    const input = cleanString(value);
    if (!/^https?:\/\//iu.test(input) || /[\s\\]/u.test(input)) return '';
    try {
        const url = new URL(input);
        if (!['http:', 'https:'].includes(url.protocol)
            || url.username || url.password || input.includes('?') || input.includes('#')) return '';
        url.pathname = url.pathname.replace(/\/+$/u, '');
        if (url.pathname !== '/v1') return '';
        return url.toString().replace(/\/$/u, '');
    } catch {
        return '';
    }
}

export function normalizeProvider(value) {
    const provider = isRecord(value) ? value : {};
    return {
        model: cleanString(provider.model),
        secretId: cleanString(provider.secretId),
        secretKey: cleanString(provider.secretKey),
        secretLabel: cleanString(provider.secretLabel),
        models: normalizeModels(provider.models),
        customUrl: normalizeCustomBaseUrl(provider.customUrl),
    };
}
