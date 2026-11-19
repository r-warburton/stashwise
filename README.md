# Stashwise

A free, unofficial Escape from Tarkov storage finder. Compare rigs, backpacks, cases and secure containers by slots gained, storage efficiency, pocket shape and acquisition cost. Sort by two metrics, configure trader access and compare up to four items with quantities.

The GitHub Pages edition runs the same Rust calculations in a browser worker using WebAssembly. GitHub Actions checks every five minutes whether prices are due, targeting source refreshes about every 15 minutes. Actual runs may be delayed or skipped, sometimes by hours. The app shows source timestamps and stale data explicitly. Favourites, views and access settings stay in your browser and can be exported/imported. No account or game access is needed.

See [the build and deployment guide](docs/hosting.md) for setup, testing, limitations and recovery. The Node/native distribution remains supported for local use.

Item data and remote artwork are attributed to [Tarkov.dev](https://tarkov.dev/) and labelled fallback services. Escape from Tarkov belongs to Battlestate Games. No game artwork or whole-game feed is committed here.
