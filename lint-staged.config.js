const rustLint = [
  "cargo fmt --all",
  "cargo clippy --workspace --all-targets -- -D warnings",
];

export default {
  "*.{js,ts,svelte}": ["eslint --fix", "prettier --write"],
  "*.{css,json,md}": "prettier --write",
  // One combined Rust glob so a commit touching both src-tauri and crates runs the
  // workspace-wide cargo fmt/clippy once, not twice.
  "{src-tauri,crates}/**/*.rs": () => rustLint,
  "{src-tauri/Cargo.toml,crates/**/Cargo.toml,Cargo.toml}": () => rustLint[1],
};
