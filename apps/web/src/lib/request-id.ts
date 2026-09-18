/**
 * 요청 식별자(UUID v4) 생성.
 *
 * `crypto.randomUUID()`는 보안 컨텍스트(https 또는 localhost)에서만 제공된다.
 * 사내망 IP + http로 화면을 열면 함수 자체가 없어 호출 시 TypeError가 난다.
 * `crypto.getRandomValues()`는 보안 컨텍스트가 아니어도 쓸 수 있으므로 그것으로 만든다.
 */
export function createRequestId(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
