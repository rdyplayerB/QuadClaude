# Archived code

## accountStore-token-vault.ts (archived 2026-07-27)
The original per-pane account system: long-lived `claude setup-token` tokens encrypted with
Electron safeStorage and injected as `CLAUDE_CODE_OAUTH_TOKEN` at PTY spawn.

Replaced by profile-dir auth: each account now maps to `~/.quadclaude/profiles/<id>` injected
as `CLAUDE_CONFIG_DIR`, so `claude /login` in a bound pane writes that profile's own Keychain
entry (`Claude Code-credentials-<sha256(dir)[0:8]>`) and its own history/sessions. No secrets
stored by QuadClaude at all. See src/main/accountStore.ts for the replacement.

Kept for reference in case a headless/no-keychain environment ever needs token injection back.
