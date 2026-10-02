// Entry point server broker: satu proses di PC Anda.
// Menyatukan: HTTP(S) endpoint, WebSocket device, antrean command, bot Telegram.
import { config, isProd } from './config.js';
import { logger } from './util/logger.js';
import { openDb } from './db/index.js';
import { devicesRepo, commandsRepo, locationsRepo, sessionsRepo } from './db/repos.js';
import { CommandDispatcher } from './commands/dispatcher.js';
import { DeviceHub } from './net/hub.js';
import { createHttpServer } from './api/http.js';
import { TelegramBot } from './telegram/bot.js';

const log = logger('main');

async function main() {
  log.info('memulai fleet guard', {
    server: config.serverName,
    env: config.env,
    publicBaseUrl: config.publicBaseUrl,
  });
  await openDb();

  const dispatcher = new CommandDispatcher();
  const hub = new DeviceHub(dispatcher);
  const bot = new TelegramBot({ dispatcher, hub });

  const server = createHttpServer({ dispatcher, hub });
  hub.attach(server);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.httpPort, '0.0.0.0', resolve);
  });
  log.info('http listen', { port: config.httpPort });

  await bot.start().catch((e) => log.error('bot gagal start', { err: e.message }));

  // ---- housekeeping ------------------------------------------------------
  const janitor = setInterval(async () => {
    try {
      const stale = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const n = await commandsRepo.markExpiredStale(stale);
      if (n) log.warn('command di-expire', { n });
      await locationsRepo.prune(config.runtime.locationRetentionDays);
      await commandsRepo.cleanupOlderThan(90);
      await sessionsRepo.prune();
    } catch (e) {
      log.error('janitor error', { err: e.message });
    }
  }, 5 * 60 * 1000);
  janitor.unref?.();

  // Bersihkan sisa flag online dari proses sebelumnya yang mati mendadak.
  // Harus SEBELUM banner dicetak, supaya angka di banner jujur.
  const resurrected = (await devicesRepo.setAllOffline()).changes;
  if (resurrected > 0) {
    log.warn('flag online sisa dari run sebelumnya dibersihkan', { n: resurrected });
  }

  // ---- startup summary ---------------------------------------------------
  const stat = await devicesRepo.countByStatus();
  const banner = [
    '',
    '  FLEET GUARD server aktif',
    `  nama        : ${config.serverName}`,
    `  http        : http://0.0.0.0:${config.httpPort}`,
    `  public url  : ${config.publicBaseUrl}`,
    `  ws device   : ${config.publicBaseUrl.replace(/^http/, 'ws')}/ws/v1/device  (sub-protocol: fleetguard.v1)`,
    `  dashboard   : ${config.publicBaseUrl}/`,
    `  device      : ${stat.total} (online ${stat.online}, disewa ${stat.disewa}, hilang ${stat.hilang})`,
    `  telegram    : ${config.telegram.token ? ' aktif' : ' TIDAK DIKONFIGURASI'}`,
    `  data dir    : ${config.runtime.dataDir}`,
    isProd ? '  mode        : production' : '  mode        : development',
    '',
  ].join('\n');
  process.stdout.write(banner + '\n');

  // ---- graceful shutdown -------------------------------------------------
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    log.info('shutdown', { signal });
    clearInterval(janitor);
    bot.stop();
    server.close();
    for (const id of hub.onlineIds()) {
      await devicesRepo.setOnline(id, false).catch(() => {});
    }
    setTimeout(() => process.exit(0), 800);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', { err: String(e) }));
  process.on('uncaughtException', (e) => {
    log.error('uncaughtException', { err: e.message, stack: e.stack });
  });
}

main().catch((e) => {
  log.error('gagal start', { err: e.message, stack: e.stack });
  process.exit(1);
});
