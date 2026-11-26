// Draws an SVG into a PNG of the given size with AppKit: swift scripts/svg2png.swift in.svg out.png 800 512
import AppKit

let args = CommandLine.arguments
guard args.count == 5, let image = NSImage(contentsOfFile: args[1]), let w = Int(args[3]), let h = Int(args[4]) else {
  FileHandle.standardError.write("usage: svg2png in.svg out.png width height\n".data(using: .utf8)!)
  exit(1)
}
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                           isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
image.draw(in: NSRect(x: 0, y: 0, width: w, height: h))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
