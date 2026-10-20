# Darkspace for Windows

The Electron desktop client connects only to `https://darkspace.purplehive.pro`. It provides:

- Windows notifications for messages and incoming calls
- taskbar flashing and a loud repeating ringtone for incoming calls
- tray/background operation so notifications continue after the window is closed
- optional launch at Windows startup
- camera, microphone, screen sharing, and call audio through the same-origin application

The renderer has no Node.js access. Context isolation and Chromium sandboxing are enabled, navigation is restricted to the Darkspace origin, and the preload exposes only validated notification, badge, and call-state messages.

## Build

```powershell
npm install
npm run desktop:build
```

Outputs are written to `release/`:

- `Darkspace-Setup-<version>-x64.exe` — interactive per-user installer
- `Darkspace-Portable-<version>-x64.exe` — standalone portable build

Set `DARKSPACE_URL` only when testing another trusted deployment. Production builds default to the live Darkspace URL.

## Signing

Local builds are unsigned. Windows SmartScreen may warn until the installer is signed with a trusted Authenticode code-signing certificate. Never distribute a build that has been signed with an untrusted or shared private key.
