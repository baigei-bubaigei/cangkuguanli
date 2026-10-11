export const standaloneBuildOptions = {
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: ["es2019"],
  minify: true,
  loader: { ".css": "empty" },
  define: { "process.env.NODE_ENV": '"production"' },
  metafile: true,
};
