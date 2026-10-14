import { readFile, writeFile } from 'node:fs/promises'

const swiftFile = new URL(
  '../node_modules/@jcesarmobile/capacitor-ocr/ios/Sources/OcrPlugin/OcrPlugin.swift',
  import.meta.url,
)

const replacements = [
  {
    original: 'import Vision\n',
    patched: 'import Vision\nimport UIKit\n',
  },
  {
    original: '        if #available(iOS 18.0, *) {\n',
    patched: `        // Match the upright image displayed by WebKit, including camera EXIF orientation.
        let originalImage: UIImage?
        if let imageData {
            originalImage = UIImage(data: imageData)
        } else if let imageURL {
            originalImage = UIImage(contentsOfFile: imageURL.path)
        } else {
            originalImage = nil
        }
        guard let originalImage else {
            call.reject("invalid image")
            return
        }
        let imageSize = originalImage.size
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: imageSize, format: format)
        imageData = renderer.image { _ in
            originalImage.draw(in: CGRect(origin: .zero, size: imageSize))
        }.pngData()
        imageURL = nil

        if #available(iOS 18.0, *) {
`,
  },
  {
    original: `                            observation["confidence"] = firstCandidate.confidence
                            results.append(observation)
`,
    patched: `                            observation["confidence"] = firstCandidate.confidence
                            let bounds = textObservation.boundingBox.cgRect
                            observation["boundingBox"] = [
                                "x": Double(bounds.minX),
                                "y": Double(1 - bounds.maxY),
                                "width": Double(bounds.width),
                                "height": Double(bounds.height)
                            ]
                            results.append(observation)
`,
  },
  {
    original: `                            observation["confidence"] = firstCandidate.confidence
                            results.append(observation)
`,
    patched: `                            observation["confidence"] = firstCandidate.confidence
                            let bounds = textObservation.boundingBox
                            observation["boundingBox"] = [
                                "x": Double(bounds.minX),
                                "y": Double(1 - bounds.maxY),
                                "width": Double(bounds.width),
                                "height": Double(bounds.height)
                            ]
                            results.append(observation)
`,
  },
  {
    original: '                    let request = RecognizeTextRequest()\n',
    patched: `                    var request = RecognizeTextRequest()
                    request.recognitionLevel = .accurate
                    request.recognitionLanguages = [
                        Locale.Language(identifier: "zh-Hans"),
                        Locale.Language(identifier: "en-US")
                    ]
                    request.automaticallyDetectsLanguage = true
`,
  },
  {
    original: `            }
            do {
                if let requestHandler {
`,
    patched: `            }
            textDetectionRequest.recognitionLevel = .accurate
            textDetectionRequest.recognitionLanguages = ["zh-Hans", "en-US"]
            if #available(iOS 16.0, *) {
                textDetectionRequest.automaticallyDetectsLanguage = true
            }
            do {
                if let requestHandler {
`,
  },
]

let source = await readFile(swiftFile, 'utf8')
let changed = false

for (const { original, patched } of replacements) {
  if (source.includes(patched)) continue
  const count = source.split(original).length - 1
  const expected = original.includes('observation["confidence"]') && patched.includes('boundingBox.cgRect') ? 2 : 1
  if (count !== expected) {
    throw new Error('OCR Swift source changed; update patches/enable-ocr-languages.mjs')
  }
  source = source.replace(original, patched)
  changed = true
}

if (changed) {
  await writeFile(swiftFile, source)
  console.log('Enabled Chinese/English OCR with original-photo line coordinates.')
}
