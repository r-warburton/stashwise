# GitHub Pages deployment

Stashwise has a static distribution: HTML, CSS, JavaScript, a 398 KiB Rust WebAssembly engine and small, normalised storage snapshots. No Node server, paid host, game account or database is needed by visitors. Images remain on the source provider's CDN. The local Windows/Node distribution remains supported.

## Build and update model

The native executable and WebAssembly library compile the same Rust calculations. Browser queries run in a worker. A visitor downloads only the storage snapshot for each market they use, not the whole-game feed. No catalogue is placed in localStorage or IndexedDB; browser HTTP caching and worker memory are used. Personal settings remain in versioned localStorage, and can be transferred with **Saved views → Export preferences / Import preferences**. Import supports old schema 1 and current schema 2, rejects invalid files and offers undo.

The `Publish Stashwise snapshots` Actions workflow runs on main pushes, manual dispatch and a five-minute cron schedule, offset to minutes 3, 8, 13 and so on. Scheduled runs first read the small public manifest: if all three source checks are recent, the run skips compilation and deployment. Pushes and normal manual runs always publish. When a refresh is due, it retrieves the previous deployed snapshots, validates their hashes and Rust schema, then checks all three upstream markets. Failed markets keep their last-good snapshot and original quote/check timestamps, with a warning. No complete initial data means no deployment. One previous snapshot generation is included for open pages using a cached manifest. Updates are Pages artifacts, not repeated data commits in the repository.

Visitors' **Check published prices** button reloads the latest published snapshot. It cannot trigger a GitHub workflow or a new upstream check. Source quotes can be older than the scheduled check. The interface explains this and marks stale/unavailable quotes. Manifests are revalidated at a bounded interval; unchanged snapshots avoid another download. Assets use a content-versioned directory.

## Repository and Pages setup

1. Use the reviewed source folder produced by `scripts/stage-public-source.mjs`. Do not upload the development project, `.cache`, logs, backups, screenshots or local preferences. The source stage includes only application code, tests, this runbook and the Pages workflow.
2. Create a public repository named `stashwise` under the intended account and push the staged files to `main`.
3. In repository **Settings → Pages → Build and deployment**, choose **GitHub Actions**. Run **Publish Stashwise snapshots** using **Run workflow** if the first push occurred before Pages was enabled.
4. Check that the build tests and deployment succeeded. Open the returned Pages URL, normally `https://OWNER.github.io/stashwise/`, and test the list, all markets, shape/access, comparison, a saved view and refresh. Do not infer successful hosting from a local preview.
5. Inspect Actions after the next scheduled run. GitHub can delay scheduled jobs, and disables scheduled workflows in public repositories after 60 days without repository activity. If disabled, re-enable the workflow in Actions or update its cron as GitHub documents; monitor the visible last-check time. Do not add dummy commits solely to evade platform limits.

GitHub Free supports Pages for public repositories. Public standard GitHub-hosted Actions usage is free subject to GitHub's policies/limits. Pages has a soft 100 GB/month bandwidth limit; review traffic if this community tool grows. No custom domain or paid service is provisioned by this source package. A public repository makes its code visible; this project does not grant an extra source licence merely by being public.

References: [Pages availability and limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits), [custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), [scheduled workflow behaviour](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Reproduce the build

Requires Node 22+ (CI uses 24), Rust 1.99.0 with `wasm32-unknown-unknown`, and wasm-bindgen CLI exactly 0.2.130 to match Cargo.lock. Keep the lockfile. Build the native executable before Node tests and create `.cache` for disposable test files.

```sh
rustup toolchain install 1.99.0 --profile minimal --component rustfmt --target wasm32-unknown-unknown
rustup default 1.99.0
mkdir -p .cache
cargo fmt --all -- --check
cargo build --release --locked
cargo test --locked
cargo build --release --locked --target wasm32-unknown-unknown --lib
cargo install wasm-bindgen-cli --version 0.2.130 --locked --root .cache/wasm-cli
.cache/wasm-cli/bin/wasm-bindgen --target web --out-dir .cache/wasm-web --out-name stashwise_core target/wasm32-unknown-unknown/release/stashwise_core.wasm
node --test tests/*.test.mjs
node scripts/build-pages.mjs
node scripts/preview-pages.mjs dist/pages
```

The preview serves `http://127.0.0.1:4319/stashwise/` to exercise the repository subpath. Build output must be a fresh directory under `dist`; use `--out dist/another-build` for another build. `PAGES_PREVIOUS_URL` optionally points to the previous public HTTPS base URL for recovery. `--cached` is for local QA with already validated `.cache/{mode}.json`; it does not claim a new price check.

The Windows development helper can use project-local extracted copies of the official Rust 1.99.0 `wasm32-unknown-unknown` standard library and wasm-bindgen 0.2.130 MSVC release archive. `scripts/build-wasm.ps1` documents the expected `.cache/wasm-tools` paths. The original implementation verified both downloads against their official SHA-256 metadata before use. These development archives are not published.

## Rollback and outages

Keep source changes in commits. If a code deployment regresses, revert the offending code commit and let the workflow rebuild; do not reset/fabricate price dates. An upstream failure leaves last-good data labelled stale. A failed build/deployment does not establish a new working release. Check Actions logs and the last deployed version before retrying. The independent local package remains available while hosting is unavailable.

The app and its data are an unofficial fan tool. Escape from Tarkov and artwork belong to Battlestate Games; data/images are attributed to Tarkov.dev and the labelled fallback sources. The deploy artifact includes dependency notices. No telemetry, account login or game-file access is added.

## Price freshness

The cron expression requests a due check every five minutes, offset from the start of the hour. The freshness gate uses the oldest successful check across all three markets, targeting 15-minute refreshes with a one-minute early allowance for build latency. A missing, invalid or unavailable manifest triggers a normal validated publication; a failed source check retains its original timestamp and remains due for retry. This is a request, not a delivery guarantee: GitHub can delay or drop scheduled runs. The app checks the published manifest every minute while visible, including an open comparison, and when returning to the tab. It pauses during settings or unfinished quantity edits. An unchanged publication preserves the actual source-check and quote timestamps.

After 30 minutes without a successful source check, the app explicitly labels the publication delayed. A new deployment can still contain old quotes when the provider is unavailable; the last-good snapshot remains visibly stale. The Check published prices button cannot trigger Actions. To inspect delivery, compare scheduled run creation timestamps in Actions with data/manifest.json mode checkedAt timestamps; workflow duration is a separate measurement.

For verification, a manual run can enable **respect_cadence** to exercise the same freshness gate used by scheduled runs. Its step summary shows the oldest actual market check and the publish/skip decision. Compare actual scheduled run creation times and successful snapshot checkedAt values over time; more frequent requested checks do not establish an improved delivered cadence by themselves.
