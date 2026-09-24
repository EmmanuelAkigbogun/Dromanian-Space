# Dromanian-Space

Communication-first collaboration platform.

## Setup

```bash
npm install
cp .env.example .env.local
```

Edit `.env.local` with your Supabase credentials.

## Development

```bash
npm run dev
```

Application runs at `http://localhost:3000`.

## Build

```bash
npm run build
npm run preview
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anonymous key |
| `VITE_APP_NAME` | Application name |
| `VITE_APP_URL` | Application URL |

## Project Structure

```
src/
  app/              # Application setup
    routes/         # Route definitions
    providers/      # Context providers
    configuration/
  features/         # Feature modules
    authentication/
    workspace/
    messaging/
    channels/
    files/
    notifications/
  components/       # Shared components
    ui/             # Base UI components
    shared/         # Shared components
    layout/         # Layout components
  services/         # External services
  hooks/            # Custom hooks
  lib/              # Libraries
  utils/            # Utilities
  types/            # TypeScript types
  styles/           # Global styles
  assets/           # Static assets
```

## License

MIT