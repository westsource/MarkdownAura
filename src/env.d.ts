/* Build-time constants injected by Vite (`define` in vite.config.ts).
 *
 * `__APP_VERSION__` comes from `package.json`, so the version the UI shows has one source: bumping
 * the package version is the whole change, and an About sheet that lies about its own version is
 * impossible. Kept in one ambient declaration rather than a `declare const` per module. */
declare const __APP_VERSION__: string;

/* KaTeX's mhchem contrib is a side-effect-only module (it patches the KaTeX instance for `\ce{…}`)
 * and the package ships no types for it. The import exists for the patch, never for a value. */
declare module "katex/dist/contrib/mhchem.mjs";
