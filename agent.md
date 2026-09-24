# Δαρκ space - Agent Configuration

## Project
A communication-first collaboration platform built with React 19, TypeScript, Vite, Supabase, and CSS Modules.

## Tech Stack
- React 19.2.7, TypeScript 6.0, Vite 8.1.1
- Supabase (`@supabase/supabase-js` 2.110.5)
- CSS Modules + CSS custom properties (NOT Tailwind)
- Path alias: `@/` → `./src`

## Conventions
- Use CSS Modules for all styling (`.module.css` files)
- Use `@/` path alias for imports
- Follow existing component patterns (memo, useCallback, CSS variables from tokens.css)
- SECURITY DEFINER functions for Supabase RLS patterns
- Toast system via `useToast()` hook
- Dialog system via `<Dialog>` component with Portal
- ContextMenu via ContextMenuProvider/Trigger/Content/Item pattern

## Skills
- [Phase 6.6: Message Performance](.agent/skills/phase-6.6-message-performance.md)
