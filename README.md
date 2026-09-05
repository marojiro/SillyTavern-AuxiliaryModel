# Auxiliary Model

Routes impersonation, Main API summaries, and Main API character expressions to a separate Chat Completion provider, key, and model in SillyTavern.

## Setup

1. Enable the extension and open **Connections → Auxiliary Model**.
2. Select a provider and save its API key. The password field clears after saving.
3. Select **Available Models** or enter a model ID in **Enter Model ID**.
4. For **Custom (OpenAI-compatible)**, enter an HTTP(S) base URL with the path `/v1`, such as `http://localhost:1234/v1`. Credentials, query parameters, and fragments are rejected.

Click the main Chat Completion **Connect** button to refresh available models. Providers without model discovery require a manual ID. Custom endpoints and anonymous Pollinations can work without an auxiliary key; other providers require one.

## Behavior

- Uses SillyTavern's native backend and the current profile's prompt behavior.
- Stores auxiliary settings per provider and restores temporarily changed connection settings after request preparation, cancellation, or timeout.
- Rejects routed requests with a missing model, invalid Custom URL, or missing required key.
- Keeps expressions on the current profile while the main reply is generating.
- Uses a separate Custom URL without inheriting custom headers, body overrides, or reverse proxy credentials. Other provider-specific connection settings come from SillyTavern.
