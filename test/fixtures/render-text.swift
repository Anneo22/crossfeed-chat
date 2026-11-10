// Renders the PNG fixtures here: swiftc render-text.swift -o render && ./render OUT.png "line" ...
import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers
// render.swift OUT.png "line1" "line2" ...  (black text on white, 900px wide)
let args = Array(CommandLine.arguments.dropFirst())
let out = args[0], lines = Array(args.dropFirst())
let w = 900, h = 40 + 34 * lines.count
let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
let font = CTFontCreateWithName("Menlo" as CFString, 20, nil)
for (i, line) in lines.enumerated() {
  let attr = NSAttributedString(string: line, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 0, green: 0, blue: 0, alpha: 1)])
  let ctl = CTLineCreateWithAttributedString(attr)
  ctx.textPosition = CGPoint(x: 20, y: h - 40 - 34 * i); CTLineDraw(ctl, ctx)
}
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, ctx.makeImage()!, nil); CGImageDestinationFinalize(dest)
