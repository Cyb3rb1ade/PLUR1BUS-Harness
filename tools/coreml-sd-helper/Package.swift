// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "MediaCoreML",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "media-coreml", targets: ["MediaCoreML"])],
    dependencies: [.package(url: "https://github.com/apple/ml-stable-diffusion.git", revision: "ea2805dc1945be20561c77e5f6d1d9a5a637cda2")],
    targets: [
        // Protocol, model discovery and the JSON-Lines session. No Core ML or StableDiffusion import: tests drive it with a fake pipeline.
        .target(name: "MediaCoreMLCore"),
        .executableTarget(name: "MediaCoreML", dependencies: ["MediaCoreMLCore", .product(name: "StableDiffusion", package: "ml-stable-diffusion")]),
        .testTarget(name: "MediaCoreMLCoreTests", dependencies: ["MediaCoreMLCore"]),
        // Runs the built `media-coreml` binary (build it first: `swift build`), so the one-shot protocol keeps being exercised.
        .testTarget(name: "MediaCoreMLCLITests"),
    ]
)
