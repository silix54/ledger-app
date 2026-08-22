import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'robots.txt', 'apple-touch-icon.png'],
      manifest: {
        name: 'Ledger Personal Finance',
        short_name: 'Ledger',
        description: 'Serverless personal budget & income manager - runs entirely in your browser.',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait-primary',
        icons: [
          { src: 'icons/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/pwa-512x512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        // Cache-First for the app shell's own static assets (JS/CSS/fonts) - once cached, opening
        // the app offline on mobile never waits on a network round trip for anything that isn't
        // ledger data. `globPatterns` covers what the Vite build actually precaches at install
        // time; `runtimeCaching` below backstops anything fetched at runtime that matches the same
        // asset types (e.g. a font loaded on demand rather than bundled).
        globPatterns: ['**/*.{js,css,html,ico,svg,png,woff,woff2}'],
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.destination === 'script' || request.destination === 'style',
            handler: 'CacheFirst',
            options: {
              cacheName: 'ledger-static-assets',
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: ({ request }) => request.destination === 'font',
            handler: 'CacheFirst',
            options: {
              cacheName: 'ledger-fonts',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
          // Cloud Sync's own APIs must never be served from the cache - Google Identity Services'
          // token issuance, Drive's file read/write, and Dropbox's OAuth/Files endpoints all need a
          // live network round trip every time; a cached "success" response here would silently
          // desync or corrupt the person's remote backup. See CONTEXT.md §3 Cloud Sync.
          {
            urlPattern: ({ url }) =>
              url.hostname === 'accounts.google.com' ||
              url.hostname === 'www.googleapis.com',
            handler: 'NetworkOnly',
          },
          {
            urlPattern: ({ url }) =>
              url.hostname === 'api.dropboxapi.com' ||
              url.hostname === 'content.dropboxapi.com' ||
              url.hostname === 'www.dropbox.com',
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
})
