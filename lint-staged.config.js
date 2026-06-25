const rustLint = [
  "cargo fmt --all",
  "cargo clippy --workspace --all-targets -- -D warnings",
];

export default {
  "*.{js,ts,svelte}": ["eslint --fix", "prettier --write"],
  "*.{css,json,md}": "prettier --write",
  "src-tauri/**/*.rs": () => rustLint,
  "crates/**/*.rs": () => rustLint,
  "{src-tauri/Cargo.toml,crates/**/Cargo.toml,Cargo.toml}": () => rustLint[1],
};
