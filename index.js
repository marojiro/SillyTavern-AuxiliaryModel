import {
    event_types,
    eventSource,
    getRequestHeaders,
    main_api,
    saveSettingsDebounced,
    substituteParams,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import {
    chat_completion_sources,
    oai_settings,
} from '../../../openai.js';
import {
    SECRET_KEYS,
    deleteSecret,
    rotateSecret,
    secret_state,
    writeSecret,
} from '../../../secrets.js';

const EXTENSION_KEY = 'auxiliaryModel';
const IMPERSONATE_TYPE = 'impersonate';
const QUIET_TYPE = 'quiet';
const SUMMARY_SOURCE_MAIN = 'main';
const EXPRESSIONS_API_LLM = 2;
const ROUTE_IMPERSONATE = 'impersonate';
const ROUTE_BUILT_IN_QUIET = 'built-in-quiet';
const BUILT_IN_ROUTE_SUMMARY = 'summary';
const BUILT_IN_ROUTE_EXPRESSIONS = 'expressions';
const PROMPT_TEMPLATE_MACRO_PATTERN = /\{\{\s*(?:words|labels)\s*\}\}/gi;
const OVERRIDE_RESTORE_TIMEOUT_MS = 10000;
const MAIN_REPLY_GUARD_TIMEOUT_MS = 300000;
const AUXILIARY_SECRET_LABEL_PREFIX = 'Auxiliary Model - ';
const CONNECT_REFRESH_SETTLE_DELAY_MS = 250;
const STATUS_SUPPORTED_SOURCES = new Set([
    chat_completion_sources.OPENAI,
    chat_completion_sources.OPENROUTER,
    chat_completion_sources.MISTRALAI,
    chat_completion_sources.CUSTOM,
    chat_completion_sources.COHERE,
    chat_completion_sources.CHUTES,
    chat_completion_sources.ELECTRONHUB,
    chat_completion_sources.NANOGPT,
    chat_completion_sources.DEEPSEEK,
    chat_completion_sources.XAI,
    chat_completion_sources.AIMLAPI,
    chat_completion_sources.POLLINATIONS,
    chat_completion_sources.GROQ,
    chat_completion_sources.MOONSHOT,
    chat_completion_sources.FIREWORKS,
    chat_completion_sources.MAKERSUITE,
    chat_completion_sources.AZURE_OPENAI,
    chat_completion_sources.SILICONFLOW,
    chat_completion_sources.WORKERS_AI,
]);

const MODEL_SETTING_BY_SOURCE = {
    [chat_completion_sources.OPENAI]: 'openai_model',
    [chat_completion_sources.CLAUDE]: 'claude_model',
    [chat_completion_sources.OPENROUTER]: 'openrouter_model',
    [chat_completion_sources.AI21]: 'ai21_model',
    [chat_completion_sources.MAKERSUITE]: 'google_model',
    [chat_completion_sources.VERTEXAI]: 'vertexai_model',
    [chat_completion_sources.MISTRALAI]: 'mistralai_model',
    [chat_completion_sources.CUSTOM]: 'custom_model',
    [chat_completion_sources.COHERE]: 'cohere_model',
    [chat_completion_sources.PERPLEXITY]: 'perplexity_model',
    [chat_completion_sources.GROQ]: 'groq_model',
    [chat_completion_sources.SILICONFLOW]: 'siliconflow_model',
    [chat_completion_sources.MINIMAX]: 'minimax_model',
    [chat_completion_sources.ELECTRONHUB]: 'electronhub_model',
    [chat_completion_sources.CHUTES]: 'chutes_model',
    [chat_completion_sources.NANOGPT]: 'nanogpt_model',
    [chat_completion_sources.DEEPSEEK]: 'deepseek_model',
    [chat_completion_sources.AIMLAPI]: 'aimlapi_model',
    [chat_completion_sources.XAI]: 'xai_model',
    [chat_completion_sources.POLLINATIONS]: 'pollinations_model',
    [chat_completion_sources.MOONSHOT]: 'moonshot_model',
    [chat_completion_sources.FIREWORKS]: 'fireworks_model',
    [chat_completion_sources.COMETAPI]: 'cometapi_model',
    [chat_completion_sources.AZURE_OPENAI]: 'azure_openai_model',
    [chat_completion_sources.ZAI]: 'zai_model',
    [chat_completion_sources.WORKERS_AI]: 'workers_ai_model',
};

const SECRET_KEY_BY_SOURCE = {
    [chat_completion_sources.OPENAI]: SECRET_KEYS.OPENAI,
    [chat_completion_sources.CLAUDE]: SECRET_KEYS.CLAUDE,
    [chat_completion_sources.OPENROUTER]: SECRET_KEYS.OPENROUTER,
    [chat_completion_sources.AI21]: SECRET_KEYS.AI21,
    [chat_completion_sources.MAKERSUITE]: SECRET_KEYS.MAKERSUITE,
    [chat_completion_sources.VERTEXAI]: SECRET_KEYS.VERTEXAI,
    [chat_completion_sources.MISTRALAI]: SECRET_KEYS.MISTRALAI,
    [chat_completion_sources.CUSTOM]: SECRET_KEYS.CUSTOM,
    [chat_completion_sources.COHERE]: SECRET_KEYS.COHERE,
    [chat_completion_sources.PERPLEXITY]: SECRET_KEYS.PERPLEXITY,
    [chat_completion_sources.GROQ]: SECRET_KEYS.GROQ,
    [chat_completion_sources.SILICONFLOW]: SECRET_KEYS.SILICONFLOW,
    [chat_completion_sources.MINIMAX]: SECRET_KEYS.MINIMAX,
    [chat_completion_sources.ELECTRONHUB]: SECRET_KEYS.ELECTRONHUB,
    [chat_completion_sources.CHUTES]: SECRET_KEYS.CHUTES,
    [chat_completion_sources.NANOGPT]: SECRET_KEYS.NANOGPT,
    [chat_completion_sources.DEEPSEEK]: SECRET_KEYS.DEEPSEEK,
    [chat_completion_sources.AIMLAPI]: SECRET_KEYS.AIMLAPI,
    [chat_completion_sources.XAI]: SECRET_KEYS.XAI,
    [chat_completion_sources.POLLINATIONS]: SECRET_KEYS.POLLINATIONS,
    [chat_completion_sources.MOONSHOT]: SECRET_KEYS.MOONSHOT,
    [chat_completion_sources.FIREWORKS]: SECRET_KEYS.FIREWORKS,
    [chat_completion_sources.COMETAPI]: SECRET_KEYS.COMETAPI,
    [chat_completion_sources.AZURE_OPENAI]: SECRET_KEYS.AZURE_OPENAI,
    [chat_completion_sources.ZAI]: SECRET_KEYS.ZAI,
    [chat_completion_sources.WORKERS_AI]: SECRET_KEYS.WORKERS_AI,
};

let settings = Object.assign(getDefaultSettings(), extension_settings[EXTENSION_KEY] ?? {});

let activeOverride = null;
let pendingGenerationRoute = '';
let pendingSecretId = '';
let restoreOverrideTimeout = null;
let mainReplyGenerationInProgress = false;
let mainReplyGenerationTimeout = null;
let connectRefreshTimeout = null;
const modelFetches = new Map();
const modelCache = new Map();

function saveSettings() {
    extension_settings[EXTENSION_KEY] = settings;
    saveSettingsDebounced();
}

function getDefaultSettings() {
    return {
        drawerOpen: true,
        source: chat_completion_sources.OPENAI,
        providers: {},
        migratedDrawerState: false,
    };
}

function initializeSettings() {
    const savedSettings = Object.assign(getDefaultSettings(), extension_settings[EXTENSION_KEY] ?? {});
    let changed = false;

    if (!savedSettings.providers || typeof savedSettings.providers !== 'object') {
        savedSettings.providers = {};
        changed = true;
    }

    if (!savedSettings.migratedDrawerState) {
        savedSettings.drawerOpen = true;
        savedSettings.migratedDrawerState = true;
        changed = true;
    }

    if (savedSettings.secretId || savedSettings.secretKey || savedSettings.model || savedSettings.modelsBySource) {
        const source = savedSettings.source || chat_completion_sources.OPENAI;
        savedSettings.providers[source] = Object.assign(getDefaultProviderSettings(), {
            model: savedSettings.model || '',
            secretId: savedSettings.secretId || '',
            secretKey: savedSettings.secretKey || '',
            models: Array.isArray(savedSettings.modelsBySource?.[source]) ? savedSettings.modelsBySource[source] : [],
        }, savedSettings.providers[source] ?? {});
        changed = true;
    }

    for (const deprecatedKey of ['enabled', 'model', 'secretId', 'secretKey', 'modelsBySource']) {
        if (Object.hasOwn(savedSettings, deprecatedKey)) {
            delete savedSettings[deprecatedKey];
            changed = true;
        }
    }

    for (const provider of Object.values(savedSettings.providers)) {
        if (!provider || typeof provider !== 'object') {
            continue;
        }

        const normalizedModels = normalizeModels(provider.models);
        if (!areModelsEqual(provider.models, normalizedModels)) {
            provider.models = normalizedModels;
            changed = true;
        }

        for (const deprecatedKey of ['secretSavedAt', 'keyLength']) {
            if (Object.hasOwn(provider, deprecatedKey)) {
                delete provider[deprecatedKey];
                changed = true;
            }
        }
    }

    extension_settings[EXTENSION_KEY] = savedSettings;
    if (changed) {
        saveSettingsDebounced();
    }
    return savedSettings;
}

function debounce(callback, delay) {
    let timeout = null;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => callback(...args), delay);
    };
}

function createElement(tagName, { id = '', classNames = [], text = '', attributes = {} } = {}) {
    const element = document.createElement(tagName);
    if (id) {
        element.id = id;
    }
    if (classNames.length > 0) {
        element.classList.add(...classNames);
    }
    if (text) {
        element.textContent = text;
    }
    for (const [name, value] of Object.entries(attributes)) {
        if (value !== undefined && value !== null) {
            element.setAttribute(name, String(value));
        }
    }
    return element;
}

function createFieldTitle(text) {
    return createElement('div', {
        classNames: ['range-block-title', 'justifyLeft'],
        text,
    });
}

function createFieldBlock(title, ...children) {
    const block = document.createElement('div');
    block.append(createFieldTitle(title), ...children);
    return block;
}

function createIconButton(id, iconClass, title) {
    return createElement('div', {
        id,
        classNames: ['menu_button', 'fa-solid', iconClass],
        attributes: { title },
    });
}

function createTextInput({ id, classNames = [], placeholder = '', list = '' } = {}) {
    const attributes = {
        type: 'text',
        autocomplete: 'off',
        placeholder,
    };
    if (list) {
        attributes.list = list;
    }

    return createElement('input', {
        id,
        classNames,
        attributes,
    });
}

function getDefaultProviderSettings() {
    return {
        model: '',
        secretId: '',
        secretKey: '',
        secretLabel: '',
        models: [],
        customUrl: '',
    };
}

function getProviderSettings(source = settings.source) {
    if (!settings.providers[source] || typeof settings.providers[source] !== 'object') {
        settings.providers[source] = getDefaultProviderSettings();
    }

    settings.providers[source] = Object.assign(getDefaultProviderSettings(), settings.providers[source]);
    return settings.providers[source];
}

function getModelSetting(source = settings.source) {
    return MODEL_SETTING_BY_SOURCE[source] ?? 'openai_model';
}

function getSelectedModel() {
    return String(getProviderSettings().model || '').trim();
}

function getStoredModels(source = settings.source) {
    const models = getProviderSettings(source).models;
    return Array.isArray(models) ? models : [];
}

function areModelsEqual(currentModels, nextModels) {
    if (!Array.isArray(currentModels) || currentModels.length !== nextModels.length) {
        return false;
    }

    return currentModels.every((model, index) => model?.id === nextModels[index]?.id && model?.name === nextModels[index]?.name);
}

function setStoredModels(provider, models) {
    if (areModelsEqual(provider.models, models)) {
        return false;
    }

    provider.models = models;
    return true;
}

function getSecretKey(source = settings.source) {
    return SECRET_KEY_BY_SOURCE[source] || '';
}

function buildAuxiliarySecretLabel(source = settings.source) {
    return `${AUXILIARY_SECRET_LABEL_PREFIX}${sourceLabel(source)}`;
}

function getAuxiliarySecretLabel(source = settings.source) {
    return getProviderSettings(source).secretLabel || buildAuxiliarySecretLabel(source);
}

function getSecretsForSource(source = settings.source) {
    const secretKey = getSecretKey(source);
    const secrets = secret_state[secretKey];
    return Array.isArray(secrets) ? secrets : [];
}

function getSecretById(secretKey, secretId) {
    const secrets = secret_state[secretKey];
    return Array.isArray(secrets) ? secrets.find(secret => secret.id === secretId) : null;
}

function findAuxiliarySecret(source = settings.source) {
    const label = getAuxiliarySecretLabel(source);
    const fallbackLabel = buildAuxiliarySecretLabel(source);
    const matchingSecrets = getSecretsForSource(source)
        .filter(secret => {
            const secretLabel = String(secret.label || '').trim();
            return secretLabel === label || secretLabel === fallbackLabel;
        });
    return matchingSecrets[matchingSecrets.length - 1] || null;
}

function resolveSavedSecret(source = settings.source) {
    const provider = getProviderSettings(source);
    const secretKey = getSecretKey(source);
    if (!secretKey) {
        return null;
    }

    const storedSecret = provider.secretKey === secretKey && provider.secretId
        ? getSecretById(secretKey, provider.secretId)
        : null;
    return storedSecret || findAuxiliarySecret(source);
}

function syncSavedSecret(source = settings.source) {
    const provider = getProviderSettings(source);
    const secretKey = getSecretKey(source);
    const secret = resolveSavedSecret(source);

    if (!secretKey) {
        provider.secretId = '';
        provider.secretKey = '';
        provider.secretLabel = '';
        return null;
    }

    if (secret) {
        provider.secretId = secret.id;
        provider.secretKey = secretKey;
        provider.secretLabel = String(secret.label || '') || getAuxiliarySecretLabel(source);
        return secret;
    }

    if (provider.secretKey === secretKey || provider.secretId) {
        provider.secretId = '';
        provider.secretKey = '';
        provider.secretLabel = '';
    }
    return null;
}

function getRestorableSecretId(secretKey, excludedId = '') {
    const secrets = secret_state[secretKey];
    if (!Array.isArray(secrets)) {
        return '';
    }

    const activeSecret = secrets.find(secret => secret.active && secret.id !== excludedId);
    return activeSecret?.id || secrets.find(secret => secret.id !== excludedId)?.id || '';
}

function hasSavedSecret(source = settings.source) {
    return Boolean(resolveSavedSecret(source));
}

function sourceLabel(source = settings.source) {
    const option = document.querySelector(`#chat_completion_source option[value="${CSS.escape(source)}"]`);
    return option?.textContent?.trim() || source;
}

function canFetchWithoutSecret(source = settings.source) {
    return source === chat_completion_sources.CUSTOM ||
        (source === chat_completion_sources.POLLINATIONS && oai_settings.pollinations_endpoint === 'anonymous');
}

function canFetchModelsForSource(source = settings.source) {
    return STATUS_SUPPORTED_SOURCES.has(source);
}

function getSavedKeyStatusText() {
    return document.getElementById('viewSecrets')?.getAttribute('key_saved_text') || 'Key saved';
}

function snapshotSettings(source = oai_settings.chat_completion_source) {
    const modelSetting = getModelSetting(source);
    return {
        source,
        modelSetting,
        model: oai_settings[modelSetting],
        customUrl: oai_settings.custom_url,
        customIncludeBody: oai_settings.custom_include_body,
        customExcludeBody: oai_settings.custom_exclude_body,
        customIncludeHeaders: oai_settings.custom_include_headers,
        reverseProxy: oai_settings.reverse_proxy,
        proxyPassword: oai_settings.proxy_password,
    };
}

function notifyAuxiliaryError(message) {
    console.warn(`[Auxiliary Model] ${message}`);
    globalThis.toastr?.error(message, 'Auxiliary Model');
}

function applyAuxiliarySettings() {
    if (activeOverride) {
        notifyAuxiliaryError('Another auxiliary request is already being prepared. Try again in a moment.');
        return false;
    }

    const source = settings.source;
    const provider = getProviderSettings(source);
    const modelSetting = getModelSetting(source);
    const model = getSelectedModel();
    const customUrl = source === chat_completion_sources.CUSTOM
        ? normalizeCustomBaseUrl(provider.customUrl)
        : '';

    if (!model) {
        notifyAuxiliaryError('Auxiliary model is empty. Enter a model ID before generating auxiliary requests.');
        return false;
    }

    if (source === chat_completion_sources.CUSTOM && !customUrl) {
        notifyAuxiliaryError('Custom endpoint must be an OpenAI-compatible base URL ending in /v1.');
        return false;
    }

    activeOverride = snapshotSettings();
    oai_settings.chat_completion_source = source;
    oai_settings.reverse_proxy = '';
    oai_settings.proxy_password = '';
    oai_settings[modelSetting] = model;
    if (source === chat_completion_sources.CUSTOM) {
        oai_settings.custom_url = customUrl;
        oai_settings.custom_include_body = '';
        oai_settings.custom_exclude_body = '';
        oai_settings.custom_include_headers = '';
    }

    pendingSecretId = syncSavedSecret(source)?.id || '';
    scheduleRestoreOverride();
    return true;
}

function scheduleRestoreOverride() {
    clearRestoreOverrideTimeout();
    restoreOverrideTimeout = setTimeout(() => {
        if (!activeOverride) {
            return;
        }

        notifyAuxiliaryError('Auxiliary request setup timed out. Restoring the main connection profile.');
        restorePrimarySettings();
    }, OVERRIDE_RESTORE_TIMEOUT_MS);
}

function clearRestoreOverrideTimeout() {
    if (restoreOverrideTimeout) {
        clearTimeout(restoreOverrideTimeout);
        restoreOverrideTimeout = null;
    }
}

function normalizePromptText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function getMessageContentText(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map(part => typeof part?.text === 'string' ? part.text : '')
            .filter(Boolean)
            .join('\n');
    }

    return '';
}

function getSystemPromptTexts(chat) {
    return Array.isArray(chat)
        ? chat
            .filter(message => message?.role === 'system')
            .map(message => getMessageContentText(message?.content))
            .filter(Boolean)
        : [];
}

function promptContainsTemplate(text, template) {
    const normalizedText = normalizePromptText(text);
    const templateParts = String(template || '')
        .split(PROMPT_TEMPLATE_MACRO_PATTERN)
        .map(normalizePromptText)
        .filter(Boolean);

    return templateParts.length > 0 && templateParts.every(part => normalizedText.includes(part));
}

function isSummaryPromptText(text) {
    if (extension_settings.memory?.source !== SUMMARY_SOURCE_MAIN) {
        return false;
    }

    return promptContainsTemplate(text, extension_settings.memory?.prompt);
}

function isExpressionPromptText(text) {
    if (Number(extension_settings.expressions?.api) !== EXPRESSIONS_API_LLM) {
        return false;
    }

    return promptContainsTemplate(text, extension_settings.expressions?.llmPrompt);
}

function getBuiltInPromptRouteFromText(text) {
    if (isExpressionPromptText(text)) {
        return BUILT_IN_ROUTE_EXPRESSIONS;
    }

    if (isSummaryPromptText(text)) {
        return BUILT_IN_ROUTE_SUMMARY;
    }

    return '';
}

function getBuiltInRawPromptRoute(chat) {
    for (const text of getSystemPromptTexts(chat)) {
        const route = getBuiltInPromptRouteFromText(text);
        if (route) {
            return route;
        }
    }

    return '';
}

function isMainReplyGeneration(type) {
    return type !== QUIET_TYPE && type !== IMPERSONATE_TYPE;
}

function setMainReplyGenerationInProgress() {
    mainReplyGenerationInProgress = true;
    clearTimeout(mainReplyGenerationTimeout);
    mainReplyGenerationTimeout = setTimeout(() => {
        mainReplyGenerationInProgress = false;
        mainReplyGenerationTimeout = null;
        console.warn('[Auxiliary Model] Main reply guard timed out. Allowing expression requests again.');
    }, MAIN_REPLY_GUARD_TIMEOUT_MS);
}

function clearMainReplyGenerationInProgress() {
    mainReplyGenerationInProgress = false;
    clearTimeout(mainReplyGenerationTimeout);
    mainReplyGenerationTimeout = null;
}

function shouldBlockExpressionPrompt(route) {
    return route === BUILT_IN_ROUTE_EXPRESSIONS && mainReplyGenerationInProgress;
}

function onGenerationStarted(type, options, dryRun) {
    if (dryRun) {
        pendingGenerationRoute = '';
        return;
    }

    if (isMainReplyGeneration(type)) {
        setMainReplyGenerationInProgress();
    }

    if (type === IMPERSONATE_TYPE) {
        pendingGenerationRoute = ROUTE_IMPERSONATE;
        return;
    }

    if (type === QUIET_TYPE) {
        const route = getBuiltInPromptRouteFromText(options?.quiet_prompt);
        if (shouldBlockExpressionPrompt(route)) {
            console.debug('[Auxiliary Model] Letting Character Expressions use the current SillyTavern profile while the main reply is still generating.');
            pendingGenerationRoute = '';
            return;
        }

        pendingGenerationRoute = route ? ROUTE_BUILT_IN_QUIET : '';
        return;
    }

    pendingGenerationRoute = '';
}

function onChatCompletionPromptReady(eventData) {
    const route = getBuiltInRawPromptRoute(eventData?.chat);
    if (main_api !== 'openai' || eventData?.dryRun || !route) {
        return;
    }

    if (shouldBlockExpressionPrompt(route)) {
        console.debug('[Auxiliary Model] Letting Character Expressions use the current SillyTavern profile while the main reply is still generating.');
        return;
    }

    if (activeOverride) {
        notifyAuxiliaryError('Another auxiliary request is already being prepared. Aborting this auxiliary request.');
        abortRawPrompt(eventData);
        return;
    }

    if (!applyAuxiliarySettings()) {
        abortRawPrompt(eventData);
    }
}

function abortRawPrompt(eventData) {
    pendingGenerationRoute = '';
    if (eventData) {
        eventData.chat = null;
    }
}

function restorePrimarySettings() {
    clearRestoreOverrideTimeout();
    if (!activeOverride) {
        pendingGenerationRoute = '';
        pendingSecretId = '';
        return;
    }

    oai_settings.chat_completion_source = activeOverride.source;
    oai_settings[activeOverride.modelSetting] = activeOverride.model;
    oai_settings.custom_url = activeOverride.customUrl;
    oai_settings.custom_include_body = activeOverride.customIncludeBody;
    oai_settings.custom_exclude_body = activeOverride.customExcludeBody;
    oai_settings.custom_include_headers = activeOverride.customIncludeHeaders;
    oai_settings.reverse_proxy = activeOverride.reverseProxy;
    oai_settings.proxy_password = activeOverride.proxyPassword;
    activeOverride = null;
    pendingGenerationRoute = '';
    pendingSecretId = '';
}

function updateKeyStatus() {
    const input = document.getElementById('auxiliary_model_api_key');
    const saveButton = document.getElementById('auxiliary_model_save_key');
    if (!input) {
        return;
    }

    const saved = Boolean(syncSavedSecret());
    input.placeholder = saved ? getSavedKeyStatusText() : 'API Key';
    saveButton?.classList.toggle('fa-check', saved);
    saveButton?.classList.toggle('fa-save', !saved);
    if (saveButton) {
        saveButton.title = saved ? 'API key saved' : 'Save API key';
    }
}

async function saveKeyFromInput() {
    const input = document.getElementById('auxiliary_model_api_key');
    const provider = getProviderSettings();
    const value = String(input?.value || '').trim();
    const secretKey = getSecretKey();
    if (!input || !value || !secretKey) {
        return;
    }

    const previousAuxId = syncSavedSecret()?.id || '';
    const restorableSecretId = getRestorableSecretId(secretKey, previousAuxId);
    const secretLabel = buildAuxiliarySecretLabel();

    const id = await writeSecret(secretKey, value, secretLabel);
    if (!id) {
        console.warn('[Auxiliary Model] Could not save API key.');
        return;
    }

    if (previousAuxId) {
        await deleteSecret(secretKey, previousAuxId);
    }

    if (restorableSecretId) {
        await rotateSecret(secretKey, restorableSecretId);
    }

    provider.secretId = id;
    provider.secretKey = secretKey;
    provider.secretLabel = secretLabel;
    setStoredModels(provider, []);
    input.value = '';
    updateKeyStatus();
    populateModelControl();
    saveSettings();
    refreshAuxiliaryModels();
}

function populateModelControl() {
    const modelInput = document.getElementById('auxiliary_model_model_id');
    const modelSelect = document.getElementById('auxiliary_model_available_models');
    const modelDatalist = document.getElementById('auxiliary_model_available_models_fill');
    if (!modelInput || !modelSelect || !modelDatalist) {
        return;
    }

    const provider = getProviderSettings();
    const fetchedModels = getStoredModels();

    if (document.activeElement !== modelInput) {
        modelInput.value = provider.model || '';
    }

    modelSelect.replaceChildren();
    modelDatalist.replaceChildren();

    if (fetchedModels.length === 0) {
        modelSelect.append(new Option('-- Connect to the API --', ''));
        modelSelect.value = '';
        return;
    }

    modelSelect.append(new Option('None', ''));
    for (const model of fetchedModels) {
        const label = model.name || model.id;
        modelSelect.append(new Option(label, model.id));
        const dataOption = document.createElement('option');
        dataOption.value = model.id;
        dataOption.label = label;
        modelDatalist.append(dataOption);
    }

    const savedModel = provider.model || '';
    modelSelect.value = fetchedModels.some(model => model.id === savedModel) ? savedModel : '';
}

function normalizeModels(responseData) {
    const sourceData = Array.isArray(responseData)
        ? responseData
        : responseData?.data?.data ?? responseData?.data ?? responseData?.models ?? [];

    if (!Array.isArray(sourceData)) {
        return [];
    }

    return sourceData
        .map(model => {
            if (typeof model === 'string') {
                return { id: model, name: model };
            }

            const id = model?.id || model?.name;
            if (!id) {
                return null;
            }

            return {
                id: String(id),
                name: String(model?.info?.name || model?.display_name || model?.name || id),
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeCustomBaseUrl(url) {
    const trimmed = String(url || '').trim();
    if (!trimmed) {
        return '';
    }

    try {
        const parsed = new URL(trimmed);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return '';
        }

        if (parsed.username || parsed.password) {
            return '';
        }

        if (parsed.search || parsed.hash) {
            return '';
        }

        parsed.pathname = parsed.pathname.replace(/\/+$/g, '');
        if (parsed.pathname !== '/v1') {
            return '';
        }

        return parsed.toString().replace(/\/$/g, '');
    } catch {
        return '';
    }
}

function getAuxiliaryStatusPayload(source = settings.source) {
    const provider = getProviderSettings(source);
    const secret = syncSavedSecret(source);
    const payload = {
        chat_completion_source: source,
        secret_id: secret?.id || undefined,
    };

    switch (source) {
        case chat_completion_sources.CUSTOM:
            payload.custom_url = normalizeCustomBaseUrl(provider.customUrl);
            payload.custom_include_headers = payload.custom_url === normalizeCustomBaseUrl(oai_settings.custom_url)
                ? substituteParams(oai_settings.custom_include_headers || '')
                : '';
            break;
        case chat_completion_sources.AZURE_OPENAI:
            payload.azure_base_url = oai_settings.azure_base_url;
            payload.azure_deployment_name = oai_settings.azure_deployment_name;
            payload.azure_api_version = oai_settings.azure_api_version;
            break;
        case chat_completion_sources.SILICONFLOW:
            payload.siliconflow_endpoint = oai_settings.siliconflow_endpoint;
            break;
        case chat_completion_sources.WORKERS_AI:
            payload.workers_ai_account_id = oai_settings.workers_ai_account_id;
            break;
        case chat_completion_sources.POLLINATIONS:
            payload.pollinations_endpoint = oai_settings.pollinations_endpoint;
            break;
    }

    return payload;
}

function getAuxiliaryModelsCacheKey(payload) {
    return JSON.stringify(payload);
}

async function fetchAuxiliaryModels(cacheKey, payload) {
    if (modelCache.has(cacheKey)) {
        return modelCache.get(cacheKey);
    }

    if (modelFetches.has(cacheKey)) {
        return modelFetches.get(cacheKey);
    }

    const promise = fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(payload),
        cache: 'no-cache',
    })
        .then(async response => {
            if (!response.ok) {
                throw new Error(response.statusText);
            }

            const responseData = await response.json();
            if (responseData?.error) {
                throw new Error(responseData?.message || 'Status endpoint returned an error.');
            }

            const models = normalizeModels(responseData);
            if (models.length > 0) {
                modelCache.set(cacheKey, models);
            }
            return models;
        })
        .finally(() => modelFetches.delete(cacheKey));

    modelFetches.set(cacheKey, promise);
    return promise;
}

async function refreshAuxiliaryModels(source = settings.source, { force = false } = {}) {
    const provider = getProviderSettings(source);
    if (!canFetchModelsForSource(source)) {
        if (settings.source === source) {
            populateModelControl();
        }
        return;
    }

    if (source === chat_completion_sources.CUSTOM && !normalizeCustomBaseUrl(provider.customUrl)) {
        const changed = setStoredModels(provider, []);
        if (settings.source === source) {
            populateModelControl();
        }
        if (changed) {
            saveSettings();
        }
        return;
    }

    if (!hasSavedSecret(source) && !canFetchWithoutSecret(source)) {
        if (settings.source === source) {
            populateModelControl();
        }
        return;
    }

    const payload = getAuxiliaryStatusPayload(source);
    const cacheKey = getAuxiliaryModelsCacheKey(payload);
    if (force) {
        modelCache.delete(cacheKey);
        modelFetches.delete(cacheKey);
    }

    try {
        const models = await fetchAuxiliaryModels(cacheKey, payload);
        if (cacheKey !== getAuxiliaryModelsCacheKey(getAuxiliaryStatusPayload(source))) {
            return;
        }

        const currentProvider = getProviderSettings(source);
        let changed = setStoredModels(currentProvider, models);
        if (models.length > 0 && !currentProvider.model) {
            currentProvider.model = models[0].id;
            changed = true;
        }
        if (settings.source === source) {
            populateModelControl();
        }
        if (changed) {
            saveSettings();
        }
    } catch (error) {
        console.warn('[Auxiliary Model] Could not load models.', error);
        if (settings.source === source) {
            populateModelControl();
        }
    }
}

const debouncedRefreshAuxiliaryModels = debounce(refreshAuxiliaryModels, 500);

function clearConnectRefreshTimeout() {
    if (connectRefreshTimeout) {
        clearTimeout(connectRefreshTimeout);
        connectRefreshTimeout = null;
    }
}

function scheduleConnectRefresh() {
    const source = settings.source;
    clearConnectRefreshTimeout();
    connectRefreshTimeout = setTimeout(() => {
        connectRefreshTimeout = null;
        refreshAuxiliaryModels(source, { force: true });
    }, CONNECT_REFRESH_SETTLE_DELAY_MS);
}

function syncControlsFromSecretState(secretKey) {
    if (secretKey !== getSecretKey()) {
        return;
    }

    modelCache.clear();
    modelFetches.clear();
    updateKeyStatus();
    populateModelControl();
    saveSettings();
}

function syncDrawerControls() {
    const auxSource = document.getElementById('auxiliary_model_source');
    const keyInput = document.getElementById('auxiliary_model_api_key');
    const customEndpointInput = document.getElementById('auxiliary_model_custom_url');
    const customEndpointBlock = document.getElementById('auxiliary_model_custom_endpoint_block');

    if (auxSource) {
        auxSource.value = settings.source;
    }

    if (keyInput) {
        keyInput.value = '';
    }

    if (customEndpointInput) {
        customEndpointInput.value = getProviderSettings().customUrl;
    }

    customEndpointBlock?.toggleAttribute('hidden', settings.source !== chat_completion_sources.CUSTOM);
    populateModelControl();
    updateKeyStatus();
}

function reloadSettingsFromStorage() {
    settings = initializeSettings();
    mountDrawer();
}

function mountDrawer() {
    createDrawer();
    syncDrawerControls();
    refreshAuxiliaryModels();
}

function onDocumentClick(event) {
    if (event.target instanceof Element && event.target.closest('#api_button_openai')) {
        scheduleConnectRefresh();
    }
}

function createDrawer() {
    if (document.getElementById('auxiliary_model_drawer')) {
        return;
    }

    const sourceSelect = document.getElementById('chat_completion_source');
    const insertionAnchorDrawer = sourceSelect?.parentElement?.querySelector('.inline-drawer[data-source]');
    if (!sourceSelect || !insertionAnchorDrawer) {
        console.warn('[Auxiliary Model] Connection Profile controls were not found.');
        return;
    }

    const drawer = document.createElement('div');
    drawer.id = 'auxiliary_model_drawer';
    drawer.classList.add('inline-drawer', 'wide100p');

    const header = createElement('div', {
        classNames: ['inline-drawer-toggle', 'inline-drawer-header'],
        text: 'Auxiliary Model',
    });
    const drawerIcon = createElement('div', {
        classNames: ['fa-solid', 'fa-circle-chevron-down', 'inline-drawer-icon', 'down'],
    });
    header.append(drawerIcon);
    drawer.append(header);

    const content = createElement('div', { classNames: ['inline-drawer-content'] });
    if (!settings.drawerOpen) {
        content.style.display = 'none';
    }

    const grid = createElement('div', { classNames: ['auxiliary-model-grid'] });
    content.append(grid);

    const auxSource = sourceSelect.cloneNode(true);
    auxSource.id = 'auxiliary_model_source';
    auxSource.name = 'auxiliary_model_source';
    auxSource.classList.add('auxiliary-model-field');
    auxSource.value = settings.source;
    grid.append(createFieldBlock('Chat Completion Source', auxSource));

    const customEndpointInput = createTextInput({
        id: 'auxiliary_model_custom_url',
        classNames: ['text_pole', 'auxiliary-model-field'],
        placeholder: 'Example: http://localhost:1234/v1',
    });
    const customEndpointBlock = createFieldBlock('Custom Endpoint (Custom URL)', customEndpointInput);
    customEndpointBlock.id = 'auxiliary_model_custom_endpoint_block';
    grid.append(customEndpointBlock);

    const keyInput = createTextInput({
        id: 'auxiliary_model_api_key',
        classNames: ['text_pole', 'flex1'],
    });
    const saveKeyButton = createIconButton('auxiliary_model_save_key', 'fa-save', 'Save API key');
    const keyRow = createElement('div', { classNames: ['auxiliary-model-key-row'] });
    keyRow.append(keyInput, saveKeyButton);
    grid.append(createFieldBlock('API Key', keyRow));

    const modelInput = createTextInput({
        id: 'auxiliary_model_model_id',
        classNames: ['text_pole', 'auxiliary-model-field'],
        placeholder: 'Example: gpt-4o',
        list: 'auxiliary_model_available_models_fill',
    });
    const modelDatalist = createElement('datalist', { id: 'auxiliary_model_available_models_fill' });
    const modelInputRow = createElement('div', { classNames: ['flex-container'] });
    modelInputRow.append(modelInput, modelDatalist);
    grid.append(createFieldBlock('Enter Model ID', modelInputRow));

    const availableModelsSelect = createElement('select', {
        id: 'auxiliary_model_available_models',
        classNames: ['text_pole', 'auxiliary-model-field'],
    });
    const availableModelsRow = createElement('div', { classNames: ['flex-container'] });
    availableModelsRow.append(availableModelsSelect);
    grid.append(createFieldBlock('Available Models', availableModelsRow));

    drawer.append(content);
    insertionAnchorDrawer.insertAdjacentElement('beforebegin', drawer);

    if (!settings.drawerOpen) {
        drawerIcon.classList.remove('down', 'fa-circle-chevron-down');
        drawerIcon.classList.add('up', 'fa-circle-chevron-up');
    }

    drawer.addEventListener('inline-drawer-toggle', () => {
        setTimeout(() => {
            settings.drawerOpen = drawerIcon.classList.contains('down');
            saveSettings();
        }, 0);
    });

    document.addEventListener('click', onDocumentClick, { capture: true });

    customEndpointInput.addEventListener('input', () => {
        const provider = getProviderSettings();
        provider.customUrl = customEndpointInput.value;
        setStoredModels(provider, []);
        if (settings.source === chat_completion_sources.CUSTOM) {
            populateModelControl();
            debouncedRefreshAuxiliaryModels();
        }
        saveSettings();
    });

    auxSource.addEventListener('change', () => {
        const nextSource = auxSource.value;
        if (settings.source !== nextSource) {
            settings.source = nextSource;
            const provider = getProviderSettings();
            keyInput.value = '';
            customEndpointInput.value = provider.customUrl;
            customEndpointBlock.toggleAttribute('hidden', settings.source !== chat_completion_sources.CUSTOM);
            populateModelControl();
            updateKeyStatus();
            saveSettings();
            refreshAuxiliaryModels();
        }
    });

    keyInput.addEventListener('blur', updateKeyStatus);
    keyInput.addEventListener('keydown', async (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            await saveKeyFromInput();
        }
    });

    saveKeyButton.addEventListener('click', saveKeyFromInput);

    modelInput.addEventListener('input', () => {
        const provider = getProviderSettings();
        provider.model = modelInput.value;
        availableModelsSelect.value = getStoredModels().some(model => model.id === provider.model) ? provider.model : '';
        saveSettings();
    });

    availableModelsSelect.addEventListener('change', () => {
        const value = String(availableModelsSelect.value || '');
        if (!value) {
            return;
        }

        const provider = getProviderSettings();
        provider.model = value;
        modelInput.value = value;
        saveSettings();
    });
}

globalThis.auxiliaryModelGenerateInterceptor = async (_chat, _contextSize, abort, type) => {
    const routeMatchesType = pendingGenerationRoute === ROUTE_IMPERSONATE
        ? type === IMPERSONATE_TYPE
        : pendingGenerationRoute === ROUTE_BUILT_IN_QUIET && type === QUIET_TYPE;

    if (main_api !== 'openai' || !routeMatchesType) {
        pendingGenerationRoute = '';
        return;
    }

    if (!applyAuxiliarySettings()) {
        pendingGenerationRoute = '';
        abort(true);
    }
};

eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
eventSource.makeFirst(event_types.CHARACTER_MESSAGE_RENDERED, clearMainReplyGenerationInProgress);
eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, (generateData) => {
    if (!activeOverride) {
        return;
    }

    if (pendingSecretId) {
        generateData.secret_id = pendingSecretId;
    }

    restorePrimarySettings();
});

eventSource.makeLast(event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
eventSource.on(event_types.GENERATION_ENDED, restorePrimarySettings);
eventSource.on(event_types.GENERATION_STOPPED, restorePrimarySettings);
eventSource.on(event_types.GENERATION_STOPPED, clearMainReplyGenerationInProgress);
eventSource.makeFirst(event_types.CHAT_CHANGED, clearMainReplyGenerationInProgress);
eventSource.on(event_types.ONLINE_STATUS_CHANGED, () => scheduleConnectRefresh());
eventSource.on(event_types.EXTENSION_SETTINGS_LOADED, reloadSettingsFromStorage);
[event_types.SECRET_WRITTEN, event_types.SECRET_DELETED, event_types.SECRET_ROTATED, event_types.SECRET_EDITED].forEach(eventType => {
    eventSource.on(eventType, syncControlsFromSecretState);
});

eventSource.on(event_types.APP_READY, reloadSettingsFromStorage);

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountDrawer, { once: true });
} else {
    mountDrawer();
}
