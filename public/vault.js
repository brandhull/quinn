// Encrypts the Baserow token + table at rest with a passphrase (PBKDF2 -> AES-GCM).
// Nothing sensitive sits in the page source; the token is only held in memory once unlocked.

const KEY = 'quinn_vault';
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(pass, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

export const hasVault = () => !!localStorage.getItem(KEY);
export const resetVault = () => localStorage.removeItem(KEY);

export async function saveVault(pass, config) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(config)));
  localStorage.setItem(KEY, JSON.stringify({ salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
}

export async function openVault(pass) {
  const { salt, iv, ct } = JSON.parse(localStorage.getItem(KEY));
  const key = await deriveKey(pass, unb64(salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
