from PIL import Image, ImageDraw
import os

icon = Image.open(r'd:\edeProject\NexusAi AgentBot\OpenFlux-Rust\src-tauri\icons\icon.png').convert('RGBA')
out_dir = r'd:\edeProject\NexusAi AgentBot\OpenFlux-Rust\src-tauri\icons'

# NSIS header image: 150x57, BMP
header = Image.new('RGBA', (150, 57), (255, 255, 255, 255))
icon_h = icon.resize((45, 45), Image.LANCZOS)
header.paste(icon_h, (100, 6), icon_h)
header.convert('RGB').save(os.path.join(out_dir, 'nsis-header.bmp'), 'BMP')
print(f'header: {os.path.getsize(os.path.join(out_dir, "nsis-header.bmp"))} bytes')

# NSIS sidebar image: 164x314, BMP
sidebar = Image.new('RGBA', (164, 314), (30, 30, 40, 255))
icon_s = icon.resize((120, 120), Image.LANCZOS)
x = (164 - 120) // 2
sidebar.paste(icon_s, (x, 60), icon_s)
draw = ImageDraw.Draw(sidebar)
for y in range(200, 314):
    draw.line([(0, y), (164, y)], fill=(20, 20, 30, 255))
sidebar.convert('RGB').save(os.path.join(out_dir, 'nsis-sidebar.bmp'), 'BMP')
print(f'sidebar: {os.path.getsize(os.path.join(out_dir, "nsis-sidebar.bmp"))} bytes')

print('Done')
