// presignUploadHelper.js
// Minimal frontend helper (can run in browser) to presign -> upload -> finalize

/**
 * usage:
 * await uploadCollection({ files, title, description, token, presignUrlBase: '/api/collections/presign', finalizeUrl: '/api/collections/finalize' })
 */

export async function uploadCollection({ files, title, description, token, presignUrl = '/api/collections/presign', finalizeUrl = '/api/collections/finalize' }) {
  if (!files || files.length === 0) throw new Error('No files');

  // Step 1: request presigns
  const presignBody = { files: files.map(f => ({ originalName: f.name, contentType: f.type, fileType: f.type.startsWith('image/') ? 'POST_IMAGE' : 'DOCUMENT', size: f.size })) };
  const presignResp = await fetch(presignUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify(presignBody) });
  if (!presignResp.ok) throw new Error('Presign request failed');
  const presignJson = await presignResp.json();

  // Step 2: upload files directly to S3
  const uploadResults = [];
  for (const presign of presignJson.presigns) {
    const file = files.shift(); // assume same order
    if (!file) throw new Error('File missing for presign');

    if (presign.method === 'POST') {
      const form = new FormData();
  for (const [k, v] of Object.entries(presign.fields || {})) form.append(k, v);
      form.append('file', file, file.name);

      const res = await fetch(presign.url, { method: 'POST', body: form });
      if (!res.ok) throw new Error('Upload to S3 failed');
      uploadResults.push({ fileId: presign.fileId, key: presign.expectedKey });
    } else if (presign.method === 'PUT') {
      const res = await fetch(presign.url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
      if (!res.ok) throw new Error('Upload to S3 failed');
      uploadResults.push({ fileId: presign.fileId, key: presign.expectedKey });
    } else {
      throw new Error('Unsupported presign method');
    }
  }

  // Step 3: finalize
  const finalizeBody = { title, description, fileReferences: uploadResults };
  const finalizeResp = await fetch(finalizeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify(finalizeBody) });
  if (!finalizeResp.ok) {
    const txt = await finalizeResp.text();
    throw new Error('Finalize failed: ' + txt);
  }
  return finalizeResp.json();
}
