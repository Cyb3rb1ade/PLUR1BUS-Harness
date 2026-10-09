import Foundation
import CoreML
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import StableDiffusion
import MediaCoreMLCore

/// Real pipeline behind `--jsonl`. Keeps the last model loaded, so repeated requests skip the load time.
/// Apple pipeline API checked 2026-10-08, pinned in Package.swift (MIT). Safety checker stays on.
@available(macOS 13.1, *)
final class AppleBackend: DiffusionBackend {
    private var cached: (key: String, pipeline: StableDiffusionPipeline)?

    private func pipeline(for job: GenerationJob) throws -> StableDiffusionPipeline {
        let key = "\(job.model.resources.path)|\(job.computeUnits.rawValue)"
        if let cached, cached.key == key { return cached.pipeline }
        cached?.pipeline.unloadResources(); cached = nil
        let config = MLModelConfiguration()
        switch job.computeUnits {
        case .cpuAndNeuralEngine: config.computeUnits = .cpuAndNeuralEngine
        case .cpuAndGPU: config.computeUnits = .cpuAndGPU
        case .all: config.computeUnits = .all
        }
        let pipeline = try StableDiffusionPipeline(resourcesAt: job.model.resources, controlNet: [], configuration: config, disableSafety: false, reduceMemory: true)
        try pipeline.loadResources()
        cached = (key, pipeline)
        return pipeline
    }

    func generate(_ job: GenerationJob, progress: (Double) -> Bool) throws -> [Data?] {
        let pipeline = try pipeline(for: job)
        var generation = PipelineConfiguration(prompt: job.prompt)
        generation.negativePrompt = job.negativePrompt
        generation.imageCount = job.imageCount
        generation.stepCount = job.steps
        generation.seed = job.seed
        generation.guidanceScale = job.guidance
        generation.disableSafety = false
        switch job.scheduler?.lowercased() {
        case nil, "pndm"?: generation.schedulerType = .pndmScheduler
        case "dpmpp"?, "dpm-solver"?, "dpmsolver"?: generation.schedulerType = .dpmSolverMultistepScheduler
        default: throw MediaCoreMLCore.HelperError.invalidRequest
        }
        if let data = job.startingImage {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw MediaCoreMLCore.HelperError.invalidRequest }
            generation.startingImage = image
            generation.strength = job.strength ?? 0.75
        }
        let images = try pipeline.generateImages(configuration: generation) { step in
            progress(Double(step.step + 1) / Double(max(step.stepCount, 1)))
        }
        return try images.map { image in
            guard let image else { return nil }
            let data = NSMutableData()
            guard let writer = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { throw MediaCoreMLCore.HelperError.backend }
            CGImageDestinationAddImage(writer, image, nil)
            guard CGImageDestinationFinalize(writer) else { throw MediaCoreMLCore.HelperError.backend }
            return data as Data
        }
    }
}
