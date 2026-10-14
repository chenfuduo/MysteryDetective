import { readFile, writeFile } from 'node:fs/promises'

const swiftFile = new URL(
  '../node_modules/@jcesarmobile/capacitor-ocr/ios/Sources/OcrPlugin/OcrPlugin.swift',
  import.meta.url,
)

const replacements = [
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
  if (source.split(original).length !== 2) {
    throw new Error('OCR Swift source changed; update patches/enable-ocr-languages.mjs')
  }
  source = source.replace(original, patched)
  changed = true
}

if (changed) {
  await writeFile(swiftFile, source)
  console.log('Enabled Simplified Chinese and English for Apple Vision OCR.')
}
