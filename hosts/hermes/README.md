# PLUR1BUS memory provider for Hermes

This package adds a Hermes memory provider that connects to the local PLUR1BUS core over its
authenticated RPC socket or Windows named pipe. The core owns the memory store; the provider
handles identity mapping, recall, and an on-disk capture journal for temporary transport failures.

## Installation

Install the Hermes host integration from
[PLUR1BUS-Host-Addons](https://github.com/Cyb3rb1ade/PLUR1BUS-Host-Addons) with
`install-plugin.sh --host hermes` on Linux/macOS or `install-plugin.ps1 -Host hermes` on Windows.
The installer vendors the Python memory client, installs the provider in the Hermes plugin
directory, and selects it as `memory.provider`. Start the PLUR1BUS core and run
`hermes plur1bus bind` to create or confirm the binding for the Hermes home.

For the provider commands and the files stored in the Hermes home, see
[`plur1bus/README.md`](plur1bus/README.md).

## Tests and checks

Run the Hermes host unit tests from the repository root:

```sh
python3 hosts/hermes/tests/run_with_timeout.py discover -v -s hosts/hermes/tests -t hosts/hermes
```

Run the package's Ruff and strict mypy checks from this directory:

```sh
ruff check plur1bus
ruff format --check plur1bus
mypy --strict
```

The end-to-end tests in `tests/e2e` require their local Hermes/core test setup; see the Hermes
host workflow for its platform-specific test commands.
