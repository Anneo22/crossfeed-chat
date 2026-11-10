import Foundation
import ImageIO
import Vision

// Prints the text macOS Vision recognizes in a local image (every frame, up to 32), on device. No network.
func fail(_ message: String) -> Never {
    fputs(message + "\n", stderr)
    exit(1)
}
guard CommandLine.arguments.count == 2 else { fail("Expected one image path") }
guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, nil) else { fail("Unreadable image") }
let frames = CGImageSourceGetCount(source)
guard frames >= 1, frames <= 32 else { fail("Unsupported image frame count") }
for index in 0..<frames {
    guard let image = CGImageSourceCreateImageAtIndex(source, index, nil) else { fail("Unreadable image") }
    // Vision refuses images this small, and they cannot carry legible text.
    if image.width < 16 || image.height < 16 { continue }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    do { try VNImageRequestHandler(cgImage: image, options: [:]).perform([request]) } catch { fail("Image text recognition failed") }
    for observation in request.results ?? [] {
        if let text = observation.topCandidates(1).first?.string { print(text) }
    }
}
exit(0)
