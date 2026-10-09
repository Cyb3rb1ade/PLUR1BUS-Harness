import Foundation

/// Where inference runs. `auto` (the absence of a choice) is resolved from the model's attention variant.
public enum ComputeUnitsChoice: String, Equatable {
    case cpuAndNeuralEngine, all, cpuAndGPU
}

/// Apple's two conversion flavours. Split-einsum is built for the Neural Engine, original for GPU/CPU.
public enum Attention: String, Equatable {
    case splitEinsum, original, unknown
    public var defaultComputeUnits: ComputeUnitsChoice {
        switch self {
        case .splitEinsum: return .cpuAndNeuralEngine
        case .original: return .cpuAndGPU
        case .unknown: return .all
        }
    }
}

public struct ModelEntry: Equatable {
    public let name: String
    public let resources: URL
    public let attention: Attention
    public init(name: String, resources: URL, attention: Attention) { self.name = name; self.resources = resources; self.attention = attention }
}

/// Stable codes shared with the TypeScript adapter (`mapHelperError`).
public enum HelperError: Error, Equatable {
    case invalidRequest, modelNotFound, contentPolicy, cancelled, backend
    public var code: String {
        switch self {
        case .invalidRequest: return "invalid_request"
        case .modelNotFound: return "model_not_found"
        case .contentPolicy: return "content_policy"
        case .cancelled: return "cancelled"
        case .backend: return "backend_unavailable"
        }
    }
}

public struct GenerationJob {
    public let model: ModelEntry
    public let computeUnits: ComputeUnitsChoice
    public let prompt: String
    public let negativePrompt: String
    public let imageCount: Int
    public let seed: UInt32
    public let steps: Int
    public let guidance: Float
    public let scheduler: String?
    /// Present for img2img: the encoded reference image and how far the result may move away from it.
    public let startingImage: Data?
    public let strength: Float?
}

/// The only place a real diffusion pipeline plugs in. A `nil` image means the pipeline's safety checker refused it.
/// `progress` receives the completed fraction and returns `false` once the job should stop.
public protocol DiffusionBackend: AnyObject {
    func generate(_ job: GenerationJob, progress: (Double) -> Bool) throws -> [Data?]
}
