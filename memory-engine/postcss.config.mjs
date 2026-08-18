// Present on purpose and deliberately empty. Without it, Next walks up the
// tree and picks up contabilidad-os's PostCSS config — Tailwind and
// autoprefixer that this app neither declares nor installs. The stylesheet
// here is plain CSS.
const config = { plugins: {} }

export default config
