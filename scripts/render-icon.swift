import AppKit
let args = CommandLine.arguments
guard args.count == 3, let px = Int(args[2]) else { fatalError("usage: render-icon <svg> <px> -> <svg>.png") }
let src = URL(fileURLWithPath: args[1])
guard let img = NSImage(contentsOf: src) else { fatalError("cannot load svg") }
guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { fatalError("bitmap") }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
img.draw(in: NSRect(x: 0, y: 0, width: px, height: px))
NSGraphicsContext.restoreGraphicsState()
guard let data = rep.representation(using: .png, properties: [:]) else { fatalError("png") }
try data.write(to: URL(fileURLWithPath: args[1] + ".png"))
print("wrote \(args[1]).png (\(px)x\(px))")
