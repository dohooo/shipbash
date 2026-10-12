# Changesets

The public CLI (`packages/cli`, npm `shipbash`) is versioned with changesets.
A change to it lands with a file here: run `bunx changeset` (or write one by
hand), pick `shipbash` and `patch` while the package is 0.0.x, and describe the
change in one line. On `main`, `.github/workflows/release-cli.yml` keeps a
"Release shipbash" pull request up to date; merging it publishes to npm.
