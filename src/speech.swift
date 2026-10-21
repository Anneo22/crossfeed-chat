import Foundation
import Speech
import AVFoundation

func fail(_ message: String) -> Never {
    fputs(message + "\n", stderr)
    exit(1)
}
guard CommandLine.arguments.count == 3 else { fail("Expected audio path and speech locale") }
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let file = try? AVAudioFile(forReading: url), file.processingFormat.sampleRate > 0,
      Double(file.length) / file.processingFormat.sampleRate <= 60 else {
    fail("Local speech requires a readable recording of at most 60 seconds")
}
guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: CommandLine.arguments[2])),
      recognizer.supportsOnDeviceRecognition else {
    fail("On-device speech is unavailable for this locale; enable its dictation language in macOS Settings")
}
let request = SFSpeechURLRecognitionRequest(url: url)
request.requiresOnDeviceRecognition = true
request.shouldReportPartialResults = false
let task = recognizer.recognitionTask(with: request) { result, error in
    if let result, result.isFinal {
        let transcript = result.bestTranscription.formattedString
        guard !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { fail("No speech recognized") }
        print(transcript)
        exit(0)
    }
    if error != nil { fail("On-device speech recognition failed") }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 30) { task.cancel(); fail("On-device speech timed out") }
RunLoop.main.run()
