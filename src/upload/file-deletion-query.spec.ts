import {
  deleteOwnedFile,
  deleteOrphanedMessageFiles,
} from './file-deletion-query';

function fixture() {
  const db = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(3),
    fileUpload: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  return db;
}

it('does not disclose or delete missing or other-owner files', async () => {
  const db = fixture();
  db.$queryRaw.mockResolvedValueOnce([]);
  await expect(deleteOwnedFile(db as any, 'file', 'owner')).rejects.toThrow(
    'File not found',
  );
  expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  expect(db.$queryRaw.mock.calls[0][0].values).toEqual(
    expect.arrayContaining(['file', 'owner']),
  );
  expect(db.$executeRaw).not.toHaveBeenCalled();
  expect(db.fileUpload.deleteMany).not.toHaveBeenCalled();
});

it.each([
  [{ inUse: true, idle: true }, 'File is still in use'],
  [{ inUse: false, idle: false }, 'currently being processed'],
])(
  'refuses a referenced or processing owned file before queueing storage deletion',
  async (state, error) => {
    const db = fixture();
    db.$queryRaw
      .mockResolvedValueOnce([{ id: 'file' }])
      .mockResolvedValueOnce([{ id: 'file', ...state }]);
    await expect(deleteOwnedFile(db as any, 'file', 'owner')).rejects.toThrow(
      error,
    );
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.fileUpload.deleteMany).not.toHaveBeenCalled();
  },
);

it('joins storage keys in PostgreSQL once and deletes only currently eligible locked files', async () => {
  const db = fixture();
  db.$queryRaw
    .mockResolvedValueOnce([
      { id: 'attached' },
      { id: 'busy' },
      { id: 'orphan' },
    ])
    .mockResolvedValueOnce([
      { id: 'attached', inUse: true, idle: true },
      { id: 'busy', inUse: false, idle: false },
      { id: 'orphan', inUse: false, idle: true },
    ]);
  expect(await deleteOrphanedMessageFiles(db as any, new Date(), 10000)).toBe(
    1,
  );
  expect(db.$queryRaw).toHaveBeenCalledTimes(2);
  const claim = db.$queryRaw.mock.calls[0][0];
  expect(claim.text).toContain('SKIP LOCKED');
  expect(claim.values).toContain(100);
  const storage = db.$executeRaw.mock.calls[0][0];
  expect(storage.text).toContain('JOIN "FileUpload"');
  expect(storage.text).toContain('ON CONFLICT');
  expect(storage.values).toEqual(['orphan', 'orphan']);
  expect(db.fileUpload.deleteMany).toHaveBeenCalledWith({
    where: { id: { in: ['orphan'] } },
  });
});

it('performs no writes on an empty or newly referenced batch and honors a zero batch size', async () => {
  const db = fixture();
  expect(await deleteOrphanedMessageFiles(db as any, new Date(), 0)).toBe(0);
  expect(db.$queryRaw).not.toHaveBeenCalled();
  db.$queryRaw.mockResolvedValueOnce([]);
  expect(await deleteOrphanedMessageFiles(db as any, new Date())).toBe(0);
  db.$queryRaw
    .mockResolvedValueOnce([{ id: 'file' }])
    .mockResolvedValueOnce([{ id: 'file', inUse: true, idle: true }]);
  expect(await deleteOrphanedMessageFiles(db as any, new Date())).toBe(0);
  expect(db.$executeRaw).not.toHaveBeenCalled();
  expect(db.fileUpload.deleteMany).not.toHaveBeenCalled();
});

it('propagates an outbox write failure before deleting any metadata', async () => {
  const db = fixture();
  db.$queryRaw
    .mockResolvedValueOnce([{ id: 'file' }])
    .mockResolvedValueOnce([{ id: 'file', inUse: false, idle: true }]);
  db.$executeRaw.mockRejectedValueOnce(new Error('database write unavailable'));
  await expect(deleteOwnedFile(db as any, 'file', 'owner')).rejects.toThrow(
    'database write unavailable',
  );
  expect(db.fileUpload.deleteMany).not.toHaveBeenCalled();
});

it('lets internal content unlinking retain a shared or already removed file without failing the content mutation', async () => {
  const db = fixture();
  db.$queryRaw
    .mockResolvedValueOnce([{ id: 'shared' }])
    .mockResolvedValueOnce([{ id: 'shared', inUse: true, idle: true }]);
  expect(await deleteOwnedFile(db as any, 'shared', 'owner', false)).toBe(0);
  db.$queryRaw.mockResolvedValueOnce([]);
  expect(await deleteOwnedFile(db as any, 'removed', 'owner', false)).toBe(0);
  expect(db.$executeRaw).not.toHaveBeenCalled();
  expect(db.fileUpload.deleteMany).not.toHaveBeenCalled();
});
