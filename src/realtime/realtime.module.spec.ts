import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { EventsGateway } from './events.gateway';
import { RealtimeModule } from './realtime.module';

const SRC_ROOT = join(__dirname, '..');

function listModuleFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return listModuleFiles(full);
    return entry.endsWith('.module.ts') ? [full] : [];
  });
}

/**
 * Every module that lists a `@WebSocketGateway` in `providers` gets its own
 * instance bound to the same socket.io server. Six of them meant six
 * `handleConnection`s and six `joined` replies per join, and the
 * `MaxListenersExceededWarning` on every connection. See RealtimeModule.
 */
describe('RealtimeModule', () => {
  it('is the only module that provides EventsGateway', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, RealtimeModule)).toEqual([
      EventsGateway,
    ]);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, RealtimeModule)).toEqual([
      EventsGateway,
    ]);

    const offenders = listModuleFiles(SRC_ROOT)
      .filter((file) => !file.endsWith(join('realtime', 'realtime.module.ts')))
      .filter((file) => /\bEventsGateway\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_ROOT, file));

    expect(offenders).toEqual([]);
  });
});
