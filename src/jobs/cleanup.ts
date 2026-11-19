import { runJob } from './run';

/**
 * Удаление комнат с истёкшим сроком хранения вместе со всем, что с ними связано.
 * Cron раз в сутки. Бессрочные комнаты (expiresAt = null) не удаляются.
 */
runJob('cleanup', async ({ service }) => `удалено комнат — ${await service.cleanupExpired()}`);
