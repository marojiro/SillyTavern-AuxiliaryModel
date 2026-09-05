import { cleanString, isRecord, normalizeModels, normalizeCustomBaseUrl, normalizeProvider } from './validation.js';
import {
    event_types,
    eventSource,
    getRequestHeaders,
    main_api,
    saveSettingsDebounced,
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
const MODEL_FETCH_TIMEOUT_MS = 30000;
const PROVIDERS = new Map([
    ['OPENAI', 'openai_model', true],
    ['CLAUDE', 'claude_model', false],
    ['OPENROUTER', 'openrouter_model', true],
    ['AI21', 'ai21_model', false],
    ['MAKERSUITE', 'google_model', true],
    ['VERTEXAI', 'vertexai_model', false],
    ['MISTRALAI', 'mistralai_model', true],
    ['CUSTOM', 'custom_model', true],
    ['COHERE', 'cohere_model', true],
    ['PERPLEXITY', 'perplexity_model', false],
    ['GROQ', 'groq_model', true],
    ['SILICONFLOW', 'siliconflow_model', true],
    ['MINIMAX', 'minimax_model', false],
    ['ELECTRONHUB', 'electronhub_model', true],
    ['CHUTES', 'chutes_model', true],
    ['NANOGPT', 'nanogpt_model', true],
    ['DEEPSEEK', 'deepseek_model', true],
    ['AIMLAPI', 'aimlapi_model', true],
    ['XAI', 'xai_model', true],
    ['POLLINATIONS', 'pollinations_model', true],
    ['MOONSHOT', 'moonshot_model', true],
    ['FIREWORKS', 'fireworks_model', true],
    ['COMETAPI', 'cometapi_model', false],
    ['AZURE_OPENAI', 'azure_openai_model', true],
    ['ZAI', 'zai_model', false],
    ['WORKERS_AI', 'workers_ai_model', true],
].flatMap(([key, modelSetting, supportsStatus]) => {
    const source = chat_completion_sources[key];
    return typeof source === 'string' && source
        ? [[source, { modelSetting, secretKey: SECRET_KEYS[key], supportsStatus }]]
        : [];
}));

let settings = initializeSettings();

let activeOverride = null;
let pendingGenerationRoute = '';
let pendingSecretId = '';
let restoreOverrideTimeout = null;
let mainReplyGenerationInProgress = false;
let mainReplyGenerationTimeout = null;
let connectRefreshTimeout = null;
const modelFetches = new Map();
const modelCache = new Map();
const modelRefreshes = new Map();
let savingKey = false;

function saveSettings() {
    extension_settings[EXTENSION_KEY] = settings;
    saveSettingsDebounced();
}

function initializeSettings() {
    const saved = isRecord(extension_settings[EXTENSION_KEY]) ? extension_settings[EXTENSION_KEY] : {};
    const source = PROVIDERS.has(saved.source) ? saved.source : chat_completion_sources.OPENAI;
    const providers = {};
    for (const key of PROVIDERS.keys()) {
        const current = isRecord(saved.providers) && Object.hasOwn(saved.providers, key)
            ? saved.providers[key] : undefined;
        if (current !== undefined || key === source) {
            const legacy = key === source ? {
                model: saved.model,
                secretId: saved.secretId,
                secretKey: saved.secretKey,
                models: saved.modelsBySource?.[key],
            } : {};
            providers[key] = normalizeProvider({ ...legacy, ...(isRecord(current) ? current : {}) });
        }
    }
    const normalized = {
        drawerOpen: saved.migratedDrawerState === true && typeof saved.drawerOpen === 'boolean'
            ? saved.drawerOpen : true,
        source,
        providers,
        migratedDrawerState: true,
    };
    extension_settings[EXTENSION_KEY] = normalized;
    if (JSON.stringify(saved) !== JSON.stringify(normalized)) {
        saveSettingsDebounced();
    }
    return normalized;
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
    const button = createElement('button', {
        id,
        classNames: ['menu_button', 'auxiliary-model-icon-button'],
        attributes: { title, type: 'button', 'aria-label': title },
    });
    button.append(createElement('i', {
        classNames: ['fa-solid', iconClass],
        attributes: { 'aria-hidden': 'true' },
    }));
    return button;
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

function getProviderSettings(source = settings.source) {
    if (!PROVIDERS.has(source)) {
        throw new TypeError('Unsupported Chat Completion source.');
    }
    return settings.providers[source] ??= normalizeProvider({});
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
    return PROVIDERS.get(source)?.secretKey || '';
}

function buildAuxiliarySecretLabel(source = settings.source) {
    return `${AUXILIARY_SECRET_LABEL_PREFIX}${sourceLabel(source)}`;
}

function getAuxiliarySecretLabel(source = settings.source) {
    return getProviderSettings(source).secretLabel || buildAuxiliarySecretLabel(source);
}

function getSecrets(secretKey) {
    const secrets = secret_state[secretKey];
    return Array.isArray(secrets) ? secrets.filter(secret => isRecord(secret) && cleanString(secret.id)) : [];
}

function getSecretById(secretKey, secretId) {
    return getSecrets(secretKey).find(secret => secret.id === secretId) ?? null;
}

function findAuxiliarySecret(source = settings.source) {
    const label = getAuxiliarySecretLabel(source);
    const fallbackLabel = buildAuxiliarySecretLabel(source);
    const matchingSecrets = getSecrets(getSecretKey(source))
        .filter(secret => {
            const secretLabel = cleanString(secret.label);
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
        provider.secretLabel = cleanString(secret.label) || getAuxiliarySecretLabel(source);
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
    const secrets = getSecrets(secretKey);

    const activeSecret = secrets.find(secret => secret.active === true && secret.id !== excludedId);
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
    return PROVIDERS.get(source)?.supportsStatus === true;
}

function getSavedKeyStatusText() {
    return document.getElementById('viewSecrets')?.getAttribute('key_saved_text') || 'Key saved';
}

function snapshotSettings(keys) {
    return keys.map(key => [key, Object.hasOwn(oai_settings, key), oai_settings[key]]);
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
    const modelSetting = PROVIDERS.get(source)?.modelSetting;
    const model = cleanString(provider.model);
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

    const secret = syncSavedSecret(source);
    if (!secret && !canFetchWithoutSecret(source)) {
        notifyAuxiliaryError('Save an auxiliary API key before generating auxiliary requests.');
        return false;
    }
    const overrides = {
        chat_completion_source: source,
        reverse_proxy: '',
        proxy_password: '',
        [modelSetting]: model,
    };
    if (source === chat_completion_sources.CUSTOM) {
        Object.assign(overrides, {
            custom_url: customUrl,
            custom_include_body: '',
            custom_exclude_body: '',
            custom_include_headers: '',
        });
    }

    activeOverride = snapshotSettings(Object.keys(overrides));
    Object.assign(oai_settings, overrides);
    pendingSecretId = secret?.id || '';
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
    return (typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim().toLowerCase();
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
    const templateParts = (typeof template === 'string' ? template : '')
        .split(PROMPT_TEMPLATE_MACRO_PATTERN)
        .map(normalizePromptText)
        .filter(Boolean);

    let offset = 0;
    return templateParts.length > 0 && templateParts.every(part => {
        const index = normalizedText.indexOf(part, offset);
        if (index < 0) return false;
        offset = index + part.length;
        return true;
    });
}

function isSummaryPromptText(text) {
    if (extension_settings.memory?.source !== SUMMARY_SOURCE_MAIN) {
        return false;
    }

    return promptContainsTemplate(text, extension_settings.memory?.prompt);
}

function isExpressionPromptText(text) {
    if (![EXPRESSIONS_API_LLM, String(EXPRESSIONS_API_LLM)].includes(extension_settings.expressions?.api)) {
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
    if (main_api !== 'openai' || typeof type !== 'string' || dryRun) {
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
    if (isRecord(eventData)) {
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

    for (const [key, existed, value] of activeOverride) {
        if (existed) oai_settings[key] = value;
        else delete oai_settings[key];
    }
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
    const value = cleanString(input.value);
    const invalid = input.value.length > 0 && !value;
    input.placeholder = saved ? getSavedKeyStatusText() : 'API Key';
    input.setCustomValidity(invalid ? 'Enter a valid API key.' : '');
    if (!saveButton) return;

    let iconClass = saved ? 'fa-check' : 'fa-save';
    let title = saved ? 'API key saved' : 'Save API key';
    if (value) {
        iconClass = saved ? 'fa-rotate' : 'fa-save';
        title = saved ? 'Update API key' : 'Save API key';
    }
    if (invalid) title = 'Enter a valid API key';
    if (savingKey) {
        iconClass = 'fa-spinner fa-spin';
        title = 'Saving API key';
    }

    const icon = saveButton.querySelector('i');
    if (icon) icon.className = `fa-solid ${iconClass}`;
    saveButton.title = title;
    saveButton.setAttribute('aria-label', title);
    saveButton.setAttribute('aria-busy', String(savingKey));
    saveButton.disabled = savingKey || !value || !getSecretKey();
}

async function saveKeyFromInput() {
    const input = document.getElementById('auxiliary_model_api_key');
    const source = settings.source;
    const value = cleanString(input?.value);
    const secretKey = getSecretKey(source);
    if (savingKey || !input || !value || !secretKey) return;

    const previousAuxId = syncSavedSecret(source)?.id || '';
    const restorableSecretId = getRestorableSecretId(secretKey, previousAuxId);
    const secretLabel = buildAuxiliarySecretLabel(source);
    savingKey = true;
    updateKeyStatus();
    try {
        const id = cleanString(await writeSecret(secretKey, value, secretLabel));
        if (!id) throw new Error('Could not save the auxiliary API key.');

        // Persist the new reference before cleanup or host events can reload settings.
        Object.assign(getProviderSettings(source), { secretId: id, secretKey, secretLabel, models: [] });
        saveSettings();
        if (settings.source === source && input.value.trim() === value) input.value = '';

        if (restorableSecretId) {
            await rotateSecret(secretKey, restorableSecretId);
            if (getSecretById(secretKey, restorableSecretId)?.active !== true) {
                throw new Error('API key saved, but the main API key could not be restored.');
            }
        }
        if (previousAuxId && previousAuxId !== id) {
            await deleteSecret(secretKey, previousAuxId);
            if (getSecretById(secretKey, previousAuxId)) {
                throw new Error('API key saved, but the previous auxiliary key could not be removed.');
            }
        }
    } catch (error) {
        notifyAuxiliaryError(error instanceof Error ? error.message : 'Could not save the auxiliary API key.');
    } finally {
        savingKey = false;
        invalidateModelRequests();
        updateKeyStatus();
        populateModelControl();
        await refreshAuxiliaryModels(source);
    }
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
            payload.custom_include_headers = '';
            break;
        case chat_completion_sources.AZURE_OPENAI:
            payload.azure_base_url = cleanString(oai_settings.azure_base_url);
            payload.azure_deployment_name = cleanString(oai_settings.azure_deployment_name);
            payload.azure_api_version = cleanString(oai_settings.azure_api_version);
            break;
        case chat_completion_sources.SILICONFLOW:
            payload.siliconflow_endpoint = cleanString(oai_settings.siliconflow_endpoint);
            break;
        case chat_completion_sources.WORKERS_AI:
            payload.workers_ai_account_id = cleanString(oai_settings.workers_ai_account_id);
            break;
        case chat_completion_sources.POLLINATIONS:
            payload.pollinations_endpoint = cleanString(oai_settings.pollinations_endpoint);
            break;
    }

    return payload;
}

function invalidateModelRequests() {
    for (const request of modelFetches.values()) request.controller.abort();
    modelFetches.clear();
    modelCache.clear();
    modelRefreshes.clear();
}

async function fetchAuxiliaryModels(cacheKey, payload) {
    if (modelCache.has(cacheKey)) return modelCache.get(cacheKey);
    if (modelFetches.has(cacheKey)) return modelFetches.get(cacheKey).promise;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MODEL_FETCH_TIMEOUT_MS);
    const request = { controller, promise: null };
    request.promise = (async () => {
        try {
            const response = await fetch('/api/backends/chat-completions/status', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(payload),
                cache: 'no-cache',
                signal: controller.signal,
            });
            if (!response.ok) throw new Error(`Status request failed (${response.status}).`);
            const data = await response.json();
            if (data?.error) throw new Error('Status endpoint returned an error.');
            const models = normalizeModels(data);
            if (modelFetches.get(cacheKey) === request && !controller.signal.aborted) {
                // Keep the cache bounded when credentials or endpoints change.
                if (modelCache.size >= PROVIDERS.size) modelCache.delete(modelCache.keys().next().value);
                modelCache.set(cacheKey, models);
            }
            return models;
        } finally {
            clearTimeout(timeout);
            if (modelFetches.get(cacheKey) === request) modelFetches.delete(cacheKey);
        }
    })();
    modelFetches.set(cacheKey, request);
    return request.promise;
}

function updateModelControls(source, changed = false) {
    if (settings.source === source) populateModelControl();
    if (changed) saveSettings();
}

async function refreshAuxiliaryModels(source = settings.source, { force = false } = {}) {
    if (!PROVIDERS.has(source) || savingKey) return;
    const provider = getProviderSettings(source);
    const token = {};
    modelRefreshes.set(source, token);
    if (!canFetchModelsForSource(source)) {
        updateModelControls(source);
        return;
    }
    if ((source === chat_completion_sources.CUSTOM && !normalizeCustomBaseUrl(provider.customUrl))
        || (!hasSavedSecret(source) && !canFetchWithoutSecret(source))) {
        updateModelControls(source, setStoredModels(provider, []));
        return;
    }

    const payload = getAuxiliaryStatusPayload(source);
    const cacheKey = JSON.stringify(payload);
    if (force) {
        modelCache.delete(cacheKey);
        modelFetches.get(cacheKey)?.controller.abort();
        modelFetches.delete(cacheKey);
    }
    try {
        const models = await fetchAuxiliaryModels(cacheKey, payload);
        if (modelRefreshes.get(source) !== token
            || cacheKey !== JSON.stringify(getAuxiliaryStatusPayload(source))) return;
        const currentProvider = getProviderSettings(source);
        let changed = setStoredModels(currentProvider, models);
        if (models.length > 0 && !currentProvider.model) {
            currentProvider.model = models[0].id;
            changed = true;
        }
        updateModelControls(source, changed);
    } catch (error) {
        if (error?.name !== 'AbortError') console.warn('[Auxiliary Model] Could not load models.', error);
        updateModelControls(source);
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
    const sources = [...PROVIDERS.keys()].filter(source => getSecretKey(source) === secretKey);
    if (!sources.length) return;
    invalidateModelRequests();
    for (const source of sources) syncSavedSecret(source);
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
        customEndpointInput.setCustomValidity('');
    }

    customEndpointBlock?.toggleAttribute('hidden', settings.source !== chat_completion_sources.CUSTOM);
    populateModelControl();
    updateKeyStatus();
}

function reloadSettingsFromStorage() {
    restorePrimarySettings();
    invalidateModelRequests();
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
    for (const option of [...auxSource.options]) {
        if (!PROVIDERS.has(option.value)) option.remove();
    }
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
    keyInput.type = 'password';
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
        provider.customUrl = normalizeCustomBaseUrl(customEndpointInput.value);
        customEndpointInput.setCustomValidity(customEndpointInput.value && !provider.customUrl
            ? 'Enter an HTTP(S) base URL ending in /v1.' : '');
        setStoredModels(provider, []);
        if (settings.source === chat_completion_sources.CUSTOM) {
            populateModelControl();
            debouncedRefreshAuxiliaryModels();
        }
        saveSettings();
    });

    auxSource.addEventListener('change', () => {
        const nextSource = auxSource.value;
        if (PROVIDERS.has(nextSource) && settings.source !== nextSource) {
            settings.source = nextSource;
            syncDrawerControls();
            saveSettings();
            refreshAuxiliaryModels();
        }
    });

    keyInput.addEventListener('input', updateKeyStatus);
    keyInput.addEventListener('blur', updateKeyStatus);
    keyInput.addEventListener('keydown', async (event) => {
        if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            await saveKeyFromInput();
        }
    });

    saveKeyButton.addEventListener('click', saveKeyFromInput);

    modelInput.addEventListener('input', () => {
        const provider = getProviderSettings();
        provider.model = cleanString(modelInput.value);
        availableModelsSelect.value = getStoredModels().some(model => model.id === provider.model) ? provider.model : '';
        saveSettings();
    });

    availableModelsSelect.addEventListener('change', () => {
        const value = cleanString(availableModelsSelect.value);
        if (!value || !getStoredModels().some(model => model.id === value)) {
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

    try {
        if (isRecord(generateData)) generateData.secret_id = pendingSecretId;
    } finally {
        restorePrimarySettings();
    }
});

eventSource.makeLast(event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
eventSource.on(event_types.GENERATION_ENDED, restorePrimarySettings);
eventSource.on(event_types.GENERATION_STOPPED, restorePrimarySettings);
eventSource.on(event_types.GENERATION_STOPPED, clearMainReplyGenerationInProgress);
eventSource.makeFirst(event_types.CHAT_CHANGED, () => {
    clearMainReplyGenerationInProgress();
    restorePrimarySettings();
});
eventSource.on(event_types.ONLINE_STATUS_CHANGED, scheduleConnectRefresh);
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
