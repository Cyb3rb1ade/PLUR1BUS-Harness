// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "MediaCoreML",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "media-coreml", targets: ["MediaCoreML"])],
    dependencies: [.package(url: "https://github.com/apple/ml-stable-diffusion.git", revision: "ea2805dc1945be20561c77e5f6d1d9a5a637cda2")],
    targets: [.executableTarget(name: "MediaCoreML", dependencies: [.product(name: "StableDiffusion", package: "ml-stable-diffusion")])]
)
