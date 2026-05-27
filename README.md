# Auxiliary Model

SillyTavern extension that routes selected auxiliary Chat Completion requests to a separate provider, API key, and model.

Use it when you want lightweight helper tasks to run on a different model while normal chat generation stays on your main Chat Completion profile.

## Routed Tasks

- Impersonation.
- Summarization when Summarize uses the Main API.
- Character Expressions when the Main API is selected.

These tasks are routed automatically based on the current SillyTavern settings.

## Setup

1. Enable the extension.
2. Open the Connections interface.
3. Open the `Auxiliary Model` drawer.
4. Select the auxiliary Chat Completion source.
5. Enter and save the auxiliary API key.
6. Choose a model from `Available Models` or type a model ID in `Enter Model ID`.

`Enter Model ID` is the model used for auxiliary requests. Selecting a model from `Available Models` fills that field.

After saving an API key, the field confirms that the key was saved and hides the key value.

## Behavior

- Uses SillyTavern's native Chat Completion backend.
- Uses the saved auxiliary API key for routed requests.
- Keeps the main Chat Completion profile selected in the UI.
- Returns to the main profile after each routed request.
- Keeps the active profile's prompt behavior.
- Uses a separate Custom endpoint URL for `Custom (OpenAI-compatible)`.
- Requires `Enter Model ID` before routing auxiliary requests.

## Models

Available models are loaded when supported by the selected provider. Click the Chat Completion `Connect` button to refresh the selected auxiliary provider.

If a provider does not expose models through the status endpoint, type the model ID manually in `Enter Model ID`.

## Custom Endpoints

`Custom (OpenAI-compatible)` uses the `Custom Endpoint (Custom URL)` field in the `Auxiliary Model` drawer.

The URL must be an OpenAI-compatible base URL ending in `/v1`.

Examples:

- `http://localhost:1234/v1`
- `https://example.com/v1`
