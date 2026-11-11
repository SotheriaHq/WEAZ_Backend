import { Readable } from 'node:stream';
import type { Request } from 'express';
import { metadataOnlyUploadStorage } from './metadata-only-upload.storage';

describe('metadata-only diagnostic uploads', () => {
  it('counts a streamed file without retaining a buffer or creating a path', async () => {
    const stream = Readable.from((function* () {
      for (let i = 0; i < 1024; i++) yield Buffer.alloc(1024);
    })());
    const metadata = await new Promise<Partial<Express.Multer.File>>((resolve, reject) => {
      metadataOnlyUploadStorage._handleFile({} as Request, { stream } as Express.Multer.File,
        (error, result) => error ? reject(error) : resolve(result!));
    });
    expect(metadata).toEqual({ size: 1024 * 1024 });
    expect(metadata.buffer).toBeUndefined();
    expect(metadata.path).toBeUndefined();
    expect(stream.destroyed).toBe(true);
  });

  it('propagates a broken upload exactly once and releases its stream', async () => {
    const failure = new Error('upload disconnected');
    const stream = new Readable({ read() { this.destroy(failure); } });
    const done = jest.fn();
    await new Promise<void>(resolve => {
      metadataOnlyUploadStorage._handleFile({} as Request, { stream } as Express.Multer.File,
        (error, result) => { done(error, result); resolve(); });
    });
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(failure, undefined);
    expect(stream.destroyed).toBe(true);
  });
});
