# Lance 2.0.0 linear algebra build patch

The sources and Apache-2.0 licence come from the Lance fork at
`7dfd9ede65693027db8852159587d24e157ee0c6`, directory `rust/lance-linalg`.
The package manifest resolves the same dependency versions without inheriting
Lance's workspace manifest.

The x86_64 distance table uses a fixed compiler architecture and tune setting.
The build still requests AVX-512BW for that kernel. The runtime checks BW, AVX2
and FMA before calling it, and takes the available AVX2 or scalar branch otherwise.
The distance table's availability marker is independent of the FP16 kernels.
Other kernels and Windows build selection follow the pin.

Remove this patch when the pinned Lance build and runtime both guarantee the
same instruction set across x86_64 distribution builds.
