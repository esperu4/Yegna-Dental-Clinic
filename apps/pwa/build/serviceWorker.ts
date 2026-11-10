/**
 * Builds the service worker (PRD §7.3, M2) after the app: one self-contained classic `sw.js` with
 * the list of files to precache and a version made from their content, so each deploy replaces the
 * offline copy of the app shell and nothing stale is served.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { type Plugin, build } from 'vite';

/** Files in `public/` that are only for the host, never fetched by the app. */
const NOT_PRECACHED = new Set(['_headers']);

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? listFiles(path, base)
      : [relative(base, path).split('\\').join('/')];
  });
}

export function serviceWorker(options: { entry: string; define: Record<string, string> }): Plugin {
  let root = '';
  let outDir = '';
  let publicDir = '';
  let bundleFiles: string[] = [];

  return {
    name: 'yegna-service-worker',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = config.build.outDir;
      publicDir = config.publicDir;
    },
    // After every plugin has written its files (Vite emits index.html late in the build).
    writeBundle(_options, bundle) {
      bundleFiles = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
    },
    async closeBundle() {
      const publicFiles = publicDir ? listFiles(publicDir).filter((f) => !NOT_PRECACHED.has(f)) : [];
      // index.html is served for every navigation (the app routes on the hash).
      const files = [...new Set([...bundleFiles, ...publicFiles])].filter((f) => f !== 'sw.js').sort();
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(root, outDir, f)));
      const version = hash.digest('hex').slice(0, 16);

      await build({
        configFile: false,
        root,
        logLevel: 'warn',
        publicDir: false,
        define: {
          ...options.define,
          // The app shell is cached as `/`: hosts redirect /index.html to / (Cloudflare does).
          __PRECACHE_FILES__: JSON.stringify(files.map((f) => (f === 'index.html' ? '/' : `/${f}`))),
          __SW_VERSION__: JSON.stringify(version),
        },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          minify: true,
          lib: {
            entry: options.entry,
            formats: ['iife'],
            name: 'yegnaServiceWorker',
            fileName: () => 'sw.js',
          },
        },
      });
    },
  };
}
