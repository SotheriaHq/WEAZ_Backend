import { SearchService } from './search.service';

describe('Search load and caller isolation', () => {
  it('shares concurrent identical database work while recording each shopper separately', async () => {
    const service = new SearchService({} as any, {} as any);
    let release!: (value: any) => void;
    const lookup = jest
      .spyOn(service as any, 'executeSearch')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
    const record = jest
      .spyOn(service as any, 'recordSearch')
      .mockResolvedValue(undefined);
    const first = service.search({
      query: 'Adire',
      userId: 'shopper-a',
      types: ['design'],
    });
    const second = service.search({
      query: 'adire',
      userId: 'shopper-b',
      types: ['design'],
    });
    release({ items: [], query: 'Adire' });
    const result = await Promise.all([first, second]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith('shopper-a', 'adire');
    expect(record).toHaveBeenCalledWith('shopper-b', 'adire');
    expect(result.map((row) => row.query)).toEqual(['Adire', 'adire']);
  });
  it('cleans up a failed flight so the next request can retry', async () => {
    const service = new SearchService({} as any, {} as any);
    jest.spyOn(service as any, 'recordSearch').mockResolvedValue(undefined);
    const lookup = jest
      .spyOn(service as any, 'executeSearch')
      .mockRejectedValueOnce(new Error('database temporarily unavailable'))
      .mockResolvedValueOnce({ items: [] });
    await expect(service.search({ query: 'adire' })).rejects.toThrow(
      'database temporarily unavailable',
    );
    await expect(service.search({ query: 'adire' })).resolves.toMatchObject({
      items: [],
    });
    expect(lookup).toHaveBeenCalledTimes(2);
  });
  it('separates brand-scoped searches', async () => {
    const service = new SearchService({} as any, {} as any);
    jest.spyOn(service as any, 'recordSearch').mockResolvedValue(undefined);
    const lookup = jest
      .spyOn(service as any, 'executeSearch')
      .mockResolvedValue({ items: [] });
    await Promise.all([
      service.search({ query: 'adire', brandId: 'brand-a' }),
      service.search({ query: 'adire', brandId: 'brand-b' }),
    ]);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
