// Deterministic JSON sources, including numeric spellings JSON.stringify loses.
export const FORMAT_CASES = ['canon', 'few', 'tz', 'pretty', 'cjk'];

export function createFormatSource(name, sizeMiB = 5) {
  if (!FORMAT_CASES.includes(name)) throw new Error(`Unknown format case: ${name}`);
  const label = name === 'cjk' ? '订单记录，包含中文内容与本地数据' : 'local record with a deterministic description';
  const makeRow = (i) => {
    const price = name === 'tz' && i % 10 === 0 ? '19.90' : '19.9';
    const coordinate = name === 'tz' && i % 10 === 0 ? '12.340' : '12.34';
    const amount = name === 'few' && i < 3 ? ['1.50', '1e3', '12345678901234567890'][i] : '42';
    return `{"id":${i},"name":"${label}","enabled":true,"price":${price},"coordinate":${coordinate},"amount":${amount},"meta":{"label":"source record","active":false},"tags":["alpha","beta","gamma"],"values":[1,2,3,4,5],"note":"offline JSON formatting benchmark"}`;
  };
  const count = Math.max(4, Math.ceil(sizeMiB * 1024 * 1024 / (Buffer.byteLength(makeRow(99999)) + 1)));
  const rows = Array.from({ length: count }, (_, i) => makeRow(i));
  const compact = '[' + rows.join(',') + ']';
  return name === 'pretty' ? JSON.stringify(JSON.parse(compact), null, 2) : compact;
}
