# Friction log

Rough edges hit in Adapty tooling during the hackathon. One line each: date | surface | what happened | suggestion.

- 2026-11-07 | CLI 0.18.0 | `ab-tests list` shows only flow tests by default; paywall tests need `--type paywall`. Easy to miss tests. | Show both types by default, or print a hint like "showing flow tests; use --type paywall".
- 2026-11-07 | CLI 0.18.0 | CLI auth can use the `ADAPTY_TOKEN` env var (README), but `adapty auth login --help` does not mention it. | Mention `ADAPTY_TOKEN` in `auth --help` and `auth login --help`.
