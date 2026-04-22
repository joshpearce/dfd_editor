# dfd_editor

Browser-based Data Flow Diagram editor. Vue 3 + Vite frontend, Flask backend
for server-side file storage, and an MCP server so external AI agents can drive
the editor.

## Recommended IDE Setup

[VSCode](https://code.visualstudio.com/) + [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar) (and disable Vetur).

## Type Support for `.vue` Imports in TS

TypeScript cannot handle type information for `.vue` imports by default, so we replace the `tsc` CLI with `vue-tsc` for type checking. In editors, we need [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar) to make the TypeScript language service aware of `.vue` types.

## Customize configuration

See [Vite Configuration Reference](https://vite.dev/config/).

## Project Setup

```sh
npm install
```

### Flask + MCP backend (first-time)

```sh
cd server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

### Run all three processes for development

```sh
npm run dev:all   # Vite (5173) + Flask (5050) + MCP (5051)
```

Or start processes individually:

```sh
npm run dev        # Vite dev server only
npm run dev:flask  # Flask backend only (port 5050)
npm run dev:mcp    # MCP server only (port 5051)
```

### Type-Check, Compile and Minify for Production

```sh
npm run build
```

### Run Unit Tests with [Vitest](https://vitest.dev/)

```sh
npm run test:unit
```

### Lint with [ESLint](https://eslint.org/)

```sh
npm run lint
```
