# Vue 3 + Vite template

Start from the platform's `vue` template. Through the CLI,
run `vibe init --template vue <slug>` in an empty folder. Through MCP, read
`vibe-coded://templates/vue`, then call `create_vibe` with `template: "vue"`.
The starter files below are included; no manual copying is needed. The platform
runs the build and serves `dist/`.

## File Structure

```
my-vibe/
  .vibe-coded.json          # Platform manifest
  package.json               # Dependencies + build script
  tsconfig.json              # TypeScript config
  vite.config.ts             # Vite config with Vue plugin
  index.html                 # HTML shell
  src/
    main.ts                  # Vue app init
    vite-env.d.ts            # Type declarations
    App.vue                  # Root component (layout shell)
    components/              # Feature components
    composables/             # Shared logic (useApi.ts, etc.)
    views/                   # Page components (if multi-page)
    router.ts                # Vue Router (if multi-page)
  worker.ts                  # Backend worker (if full-stack)
```

## package.json

```json
{
  "name": "my-vibe",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "vue": "^3.4.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^6.0.0",
    "vite": "^7.0.0",
    "typescript": "^5.0.0"
  }
}
```

Keep `vite` and `@vitejs/plugin-vue` in `devDependencies` (the build fails
with "vite: not found" otherwise). Add `"vue-router": "^4"` for multi-page apps.

## tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "preserve",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "src/**/*.vue", "*.ts"]
}
```

Keep `"moduleResolution": "bundler"`.

## vite.config.ts

```typescript
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
});
```

## index.html

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>My Vibe</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

## src/main.ts

```typescript
import { createApp } from 'vue';
import App from './App.vue';

createApp(App).mount('#app');
```

For multi-page apps with Vue Router:
```typescript
import { createApp } from 'vue';
import App from './App.vue';
import router from './router';

const app = createApp(App);
app.use(router);
app.mount('#app');
```

## src/App.vue

```vue
<script setup lang="ts">
const title = 'My Vibe';
</script>

<template>
  <main>
    <h1>{{ title }}</h1>
    <p>Your Vue app is ready.</p>
  </main>
</template>
```

## src/vite-env.d.ts

```typescript
/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
```

## Install, build, and preview

Through MCP, `create_vibe` with `template: "vue"` pushes the starter files and
waits for the preview build, reporting its outcome. Edit with `push_source`,
which also waits for the build; check pages with `fetch_page` and any backend
tools with `call_tool`, then publish when the user asks. The platform installs
dependencies and runs the build.

Through the CLI, after `vibe init --template vue <slug>`, a local `npm install`
and `npm run build` are an optional check that the build passes; the platform
installs and builds on its own when you run `vibe preview`:

```bash
npm install && npm run build   # optional
vibe preview
```


## Vue Router (Multi-Page)

```typescript
// src/router.ts
import { createRouter, createWebHashHistory } from 'vue-router';
import HomeView from './views/HomeView.vue';

const router = createRouter({
  history: createWebHashHistory(),  // hash history, not createWebHistory()
  routes: [
    { path: '/', component: HomeView },
  ]
});

export default router;
```


## API Composable Pattern

```typescript
// src/composables/useApi.ts
export function useApi() {
  async function listItems(status?: string) {
    const res = await fetch('/api/list_items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    const { success, data, error } = await res.json();
    if (!success) throw new Error(error);
    return data;
  }

  async function createItem(name: string) {
    const res = await fetch('/api/create_item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const { success, data, error } = await res.json();
    if (!success) throw new Error(error);
    return data;
  }

  return { listItems, createItem };
}
```

Call tools with `POST` on relative `/api/<tool_name>` paths.
