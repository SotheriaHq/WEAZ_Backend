import type { StorageEngine } from 'multer';
import { Writable, pipeline } from 'node:stream';

/** Diagnostics use file metadata only. Never buffer or persist uploaded bytes. */
export const metadataOnlyUploadStorage: StorageEngine = {
  _handleFile(_request, file, done) {
    let size = 0;
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        callback();
      },
    });
    pipeline(file.stream, sink, (error) => {
      done(error ?? null, error ? undefined : { size });
    });
  },
  _removeFile(_request, _file, done) {
    done(null);
  },
};
