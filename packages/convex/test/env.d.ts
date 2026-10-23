// Vite's `import.meta.glob`, which convex-test uses to load function modules.
// Declared here because `vite/client` is not a direct dependency.
interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
}

// Vite's `?raw` import: a file's text.
declare module "*?raw" {
    const text: string;
    export default text;
}
