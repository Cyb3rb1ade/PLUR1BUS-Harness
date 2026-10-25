# CMake toolchain file for the protoc build of `protobuf-src` (the `protoc` feature of `lance`, named in this crate's
# Cargo.toml) on Windows MSVC hosts. `.cargo/config.toml` names it through CMAKE_TOOLCHAIN_FILE_<target>, which the
# `cmake` crate passes on as -DCMAKE_TOOLCHAIN_FILE. It sets one cache entry and nothing else: no compiler, no system
# name, so CMake does not treat the build as a cross build.
#
# protobuf-src 2.1.1+27.1 vendors protobuf 27.2, which compiles its own targets (libprotobuf, libprotoc, libupb,
# utf8_range, protoc) against the static CRT (`protobuf_MSVC_STATIC_RUNTIME`, default ON: /MTd in Debug) and its bundled
# abseil against the DLL CRT (abseil's own `ABSL_MSVC_STATIC_RUNTIME`, default OFF: /MDd), without passing its choice on
# to abseil. Linking protoc.exe then fails with LNK2038 (RuntimeLibrary mismatch) and unresolved __imp_* CRT symbols.
# OFF puts protobuf on the DLL CRT that abseil already uses, the one the `cmake` crate asks for (-MD) and Rust links.
#
# CMake takes a toolchain file only when it first configures a build tree: a tree left by a build without this file
# (target/<profile>/build/protobuf-src-*/out/build) keeps failing until `cargo clean -p protobuf-src`.
#
# Remove this file, its two .cargo/config.toml entries and tests/msvc_crt.rs when the vendored protobuf passes
# protobuf_MSVC_STATIC_RUNTIME on to ABSL_MSVC_STATIC_RUNTIME itself (protobuf 35.0's CMakeLists.txt does), or when the
# engine stops building protoc from source.
set(protobuf_MSVC_STATIC_RUNTIME OFF CACHE BOOL "Link static runtime libraries")
