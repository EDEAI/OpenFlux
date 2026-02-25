from PIL import Image
import os
import struct

icon_path = r'd:\edeProject\NexusAi AgentBot\OpenFlux-Rust\src-tauri\icons\icon.png'
out_dir = r'd:\edeProject\NexusAi AgentBot\OpenFlux-Rust\src-tauri\icons'

icon = Image.open(icon_path).convert('RGBA')

# 生成各尺寸 PNG
sizes = {
    '32x32.png': 32,
    '128x128.png': 128,
    '128x128@2x.png': 256,
}

for name, size in sizes.items():
    resized = icon.resize((size, size), Image.LANCZOS)
    resized.save(os.path.join(out_dir, name), 'PNG')
    print(f'{name}: {size}x{size} done')

# 生成 ICO (包含多个尺寸)
ico_sizes = [16, 24, 32, 48, 64, 128, 256]
ico_images = []
for s in ico_sizes:
    ico_images.append(icon.resize((s, s), Image.LANCZOS))

ico_path = os.path.join(out_dir, 'icon.ico')
ico_images[0].save(ico_path, format='ICO', sizes=[(s, s) for s in ico_sizes], append_images=ico_images[1:])
print(f'icon.ico: {os.path.getsize(ico_path)} bytes ({len(ico_sizes)} sizes)')

# 生成 ICNS (macOS) - 用 PNG 256x256 替代，Tauri 会处理
icns_png = icon.resize((256, 256), Image.LANCZOS)
icns_png.save(os.path.join(out_dir, 'icon_256.png'), 'PNG')
print(f'icon_256.png for icns reference done')

print('All icons generated!')
