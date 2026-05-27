# Decode the garbled text from Gateway:ERR line
# The garbled chars come from: Node.js outputs GBK bytes -> Rust reads as UTF-8 -> partial decode

garbled = 'Ϣ:    ṩ  ģʽ   ҵ  ļ'

result_bytes = bytearray()
for ch in garbled:
    encoded = ch.encode('utf-8')
    result_bytes.extend(encoded)

print('All hex:', result_bytes.hex())
print('All bytes:', list(result_bytes))

# Remove null/zero bytes (spaces in display may be 0x20 space chars)
# Try different approaches: 
# 1. Remove all bytes < 0x80 that are spaces
clean1 = bytes(b for b in result_bytes if b != 0x20)
print('No-space hex:', clean1.hex())
try:
    print('GBK (no space):', clean1.decode('gbk', errors='replace'))
except Exception as e:
    print('Error:', e)

# 2. Keep only bytes >= 0x80
clean2 = bytes(b for b in result_bytes if b >= 0x80)
print('High-byte hex:', clean2.hex())
try:
    print('GBK (high only):', clean2.decode('gbk', errors='replace'))
except Exception as e:
    print('Error:', e)

# 3. Keep all non-zero bytes
clean3 = bytes(b for b in result_bytes if b != 0)
print('Non-zero hex:', clean3.hex())
try:
    print('GBK (non-zero):', clean3.decode('gbk', errors='replace'))
except Exception as e:
    print('Error:', e)

# 4. Try treating actual spaces as separators between GBK pairs
# Collect only the non-space Unicode chars and their UTF-8 bytes
non_space = [ch for ch in garbled if ch != ' ']
ns_bytes = bytearray()
for ch in non_space:
    ns_bytes.extend(ch.encode('utf-8'))
print('Non-space chars:', non_space)
print('Non-space hex:', ns_bytes.hex())
try:
    print('GBK (non-space chars):', ns_bytes.decode('gbk', errors='replace'))
except Exception as e:
    print('Error:', e)
