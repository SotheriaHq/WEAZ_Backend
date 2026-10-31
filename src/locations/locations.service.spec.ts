import { LocationsService } from './locations.service';

const json = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

describe('LocationsService', () => {
  let fetchMock: jest.Mock;
  let service: LocationsService;

  beforeEach(() => {
    process.env.LOCATION_DATA_API_URL = 'https://locations.test/api';
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    service = new LocationsService();
  });
  afterAll(() => {
    delete process.env.LOCATION_DATA_API_URL;
  });

  it('lists countries from the bundled list, without regions that are not countries', () => {
    const countries = service.listCountries();
    expect(countries).toContainEqual({ iso2: 'NG', name: 'Nigeria' });
    expect(countries.some((country) => country.iso2 === 'EU')).toBe(false);
    expect(countries.length).toBeGreaterThan(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches states server-side by country code, once, and caches them', async () => {
    fetchMock.mockResolvedValue(
      json({
        error: false,
        data: {
          states: [
            { name: 'Lagos' },
            { name: 'Lagos' },
            { name: 'Oyo' },
            { name: 7 },
          ],
        },
      }),
    );
    const [first, second] = await Promise.all([
      service.listStates('NG'),
      service.listStates('NG'),
    ]);
    expect(first).toEqual(['Lagos', 'Oyo']);
    expect(second).toEqual(['Lagos', 'Oyo']);
    expect(await service.listStates('ng')).toEqual(['Lagos', 'Oyo']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe(
      'https://locations.test/api/states/q',
    );
    expect(url.searchParams.get('country')).toBe('Nigeria');
  });

  it('answers an empty list when the source fails, and does not retry at once', async () => {
    fetchMock.mockResolvedValue(json({}, 503));
    expect(await service.listCities('NG', 'Lagos')).toEqual([]);
    expect(await service.listCities('NG', 'Lagos')).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    expect(await service.listCities('NG', 'Oyo')).toEqual([]);
  });

  it('refuses names that could not be a place, without calling the source', async () => {
    expect(await service.listStates('<script>')).toEqual([]);
    expect(await service.listCities('NG', 'a'.repeat(200))).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
