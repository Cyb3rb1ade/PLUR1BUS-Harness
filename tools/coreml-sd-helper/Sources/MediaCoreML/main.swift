import Foundation
import CoreML
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import StableDiffusion
import Darwin

// Protocol v1. Apple pipeline API checked 2026-10-07, pinned in Package.swift (MIT).
// Signal handlers do no allocation, I/O or locking. The next diffusion step observes cancellation.
private var cancelled: sig_atomic_t = 0
signal(SIGTERM) { _ in cancelled = 1 }
signal(SIGINT) { _ in cancelled = 1 }

struct ImageRequest: Decodable {
    let prompt: String
    let negativePrompt: String?
    let n: Int?
    let seed: UInt32?
    let steps: Int?
    let guidance: Float?
}
struct Request: Decodable {
    let operation: String
    let model: String
    let modelDir: String
    let outputDir: String
    let request: ImageRequest?
}
func emit(_ message: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: message, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}
enum HelperError: Error { case invalidRequest, invalidModel, failedOutput, contentPolicy, cancelled }

@available(macOS 13.1, *)
func run(_ input: Request) throws {
    let root = URL(fileURLWithPath: NSString(string: input.modelDir).expandingTildeInPath).resolvingSymlinksInPath()
    let entries = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    let models = entries.filter { url in
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        return values?.isDirectory == true && values?.isSymbolicLink != true
            && FileManager.default.fileExists(atPath: url.appendingPathComponent("TextEncoder.mlmodelc").path)
            && FileManager.default.fileExists(atPath: url.appendingPathComponent("VAEDecoder.mlmodelc").path)
    }.map { $0.lastPathComponent }.sorted()
    if input.operation == "list" { try emit(["type": "models", "models": models]); return }
    guard input.operation == "generate", let request = input.request,
          !request.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          models.contains(input.model), !input.model.contains("/"), input.model != ".." else { throw HelperError.invalidRequest }
    let n = request.n ?? 1
    let steps = request.steps ?? 30
    guard (1...10).contains(n), (1...1000).contains(steps), request.guidance?.isFinite ?? true else { throw HelperError.invalidRequest }
    let config = MLModelConfiguration()
    config.computeUnits = .all
    let pipeline = try StableDiffusionPipeline(resourcesAt: root.appendingPathComponent(input.model), controlNet: [], configuration: config, disableSafety: false, reduceMemory: true)
    try pipeline.loadResources()
    defer { pipeline.unloadResources() }
    var generation = PipelineConfiguration(prompt: request.prompt)
    generation.negativePrompt = request.negativePrompt ?? ""
    generation.imageCount = n
    generation.stepCount = steps
    generation.seed = request.seed ?? UInt32.random(in: 0...UInt32.max)
    generation.guidanceScale = request.guidance ?? 7.5
    generation.disableSafety = false
    let images = try pipeline.generateImages(configuration: generation) { progress in
        try? emit(["type": "progress", "fraction": Double(progress.step + 1) / Double(max(progress.stepCount, 1))])
        return cancelled == 0
    }
    if cancelled != 0 { throw HelperError.cancelled }
    // Nil images mean the pipeline's safety checker refused them. Never return the other images to bypass that decision.
    guard images.count == n, images.allSatisfy({ $0 != nil }) else { throw HelperError.contentPolicy }
    let output = URL(fileURLWithPath: input.outputDir)
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    var files: [String] = []
    for (index, image) in images.enumerated() {
        let name = "\(index).png"
        let destination = output.appendingPathComponent(name)
        let data = NSMutableData()
        guard let writer = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil), let image = image else { throw HelperError.failedOutput }
        CGImageDestinationAddImage(writer, image, nil)
        guard CGImageDestinationFinalize(writer) else { throw HelperError.failedOutput }
        try (data as Data).write(to: destination, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
        files.append(name)
    }
    try emit(["type": "result", "files": files, "seed": generation.seed])
}

do {
    #if arch(arm64)
    guard #available(macOS 13.1, *) else { throw HelperError.invalidModel }
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count <= 1_048_576 else { throw HelperError.invalidRequest }
    try run(JSONDecoder().decode(Request.self, from: data))
    #else
    throw HelperError.invalidModel
    #endif
} catch {
    let code = (error as? HelperError) == .contentPolicy ? "content_policy" : "backend_unavailable"
    try? emit(["type": "error", "code": code])
    exit(1)
}
