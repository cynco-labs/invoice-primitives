// Vite's `import.meta.glob`, which convex-test uses to load function modules.
// Declared here because `vite/client` is not a direct dependency.
interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
}
