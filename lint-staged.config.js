const rustLint = [
  "cargo fmt --manifest-path src-tauri/Cargo.toml",
  "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings",
];

export default {
  "*.{js,ts,svelte}": ["eslint --fix", "prettier --write"],
  "*.{css,json,md}": "prettier --write",
  "src-tauri/**/*.rs": () => rustLint,
  "src-tauri/Cargo.toml": () => rustLint[1],
};
