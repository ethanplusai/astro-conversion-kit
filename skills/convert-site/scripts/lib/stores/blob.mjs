// Vercel Blob over its REST API (no SDK): PUT the object, HEAD its public URL.
// The token is only ever sent in the authorization header, never logged.
//
// The request mirrors @vercel/blob 2.8.2's put() for a read-write token (dist/chunk-XKVPKJPO.js,
// requestApi and createPutHeaders): PUT https://vercel.com/api/blob/?pathname=<key> with the raw
// body, x-api-version 13, the store id parsed from the token (vercel_blob_rw_<storeId>_<secret>)
// in x-vercel-blob-store-id and in x-api-blob-request-id, the attempt number, and the put
// options as x-* headers. The response is JSON: { url, downloadUrl, pathname, contentType,
// contentDisposition }. Checked against a real public store (Vercel CLI 65.1.0, October 2026): the
// PUT answers 200 with that JSON, a re-PUT of an existing key with x-allow-overwrite answers 200,
// and the public url's HEAD carries content-length, content-type and cache-control. The PUT
// response has no etag, as a header or a field: the manifest's etag comes from the HEAD.
// The token is never told apart by its prefix: the value `vercel env ls` shows for a token from
// `vercel storage connect --auth token --add-rw-token` begins eyJ, not vercel_blob_rw_.
import { randomBytes } from 'node:crypto';
import { fetchWithRetry } from './retry.mjs';

export const BLOB_ENDPOINT = 'https://vercel.com/api/blob';
export const BLOB_API_VERSION = '13';
export const BLOB_ENV = ['BLOB_READ_WRITE_TOKEN'];

// The put options, as @vercel/blob names them. x-vercel-blob-access: public makes the object
// readable at its returned url, which the media rewrite points at. x-allow-overwrite lets a
// re-PUT succeed after a failed HEAD or a lost manifest.
export const BLOB_PUT_HEADERS = Object.freeze({
  authorization: 'Bearer <BLOB_READ_WRITE_TOKEN>',
  'x-api-version': BLOB_API_VERSION,
  'x-vercel-blob-store-id': '<store id>',
  'x-api-blob-request-id': '<store id>:<ms>:<random hex>',
  'x-api-blob-request-attempt': '0',
  'x-vercel-blob-access': 'public',
  'x-content-type': '<content type>',
  'x-add-random-suffix': '0',
  'x-allow-overwrite': '1',
  'x-cache-control-max-age': '31536000',
});

// vercel_blob_rw_<storeId>_<secret>, as parseStoreIdFromReadWriteToken reads it.
export function storeIdFromToken(token) {
  return String(token ?? '').split('_')[3] ?? '';
}

function blobPutHeaders(token, contentType) {
  const storeId = storeIdFromToken(token);
  return {
    ...BLOB_PUT_HEADERS,
    authorization: `Bearer ${token}`,
    'x-vercel-blob-store-id': storeId,
    'x-api-blob-request-id': `${storeId}:${Date.now()}:${randomBytes(6).toString('hex')}`,
    'x-content-type': contentType,
  };
}

export function createBlobStore({ env = process.env, endpoint = BLOB_ENDPOINT } = {}) {
  const token = env.BLOB_READ_WRITE_TOKEN;
  const base = endpoint.replace(/\/+$/, '');
  return {
    async put(key, body, contentType) {
      const res = await fetchWithRetry(`${base}/?${new URLSearchParams({ pathname: key })}`, {
        method: 'PUT',
        headers: blobPutHeaders(token, contentType),
        body,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Blob PUT ${key} answered ${res.status}: ${text.slice(0, 200)}`);
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Blob PUT ${key} returned a response that is not JSON`);
      }
      if (!json.url) throw new Error(`Blob PUT ${key} response has no url`);
      return { url: json.url, etag: json.etag ?? res.headers.get('etag') ?? null };
    },
    async head(url) {
      // identity: a compressed answer (SVG, JSON) carries no content-length to compare.
      const res = await fetchWithRetry(url, { method: 'HEAD', headers: { 'accept-encoding': 'identity' } });
      if (!res.ok) throw new Error(`HEAD ${url} answered ${res.status}`);
      return { bytes: Number(res.headers.get('content-length')), etag: res.headers.get('etag') };
    },
  };
}
