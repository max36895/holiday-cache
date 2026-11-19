import { runJob } from './run';

/**
 * Расписание: cron раз в 5 минут. Вызывает onSchedule режимов в комнатах
 * с наступившим rooms.nextRunAt и доставляет отложенные анонимные сообщения.
 * Повторный запуск в ту же минуту ничего не отправит второй раз: ключи сообщений
 * в журнале sendLog.
 */
runJob('tick', async ({ scheduler }) => {
    const { rooms, messages } = await scheduler.tick();
    return `комнат — ${rooms}, сообщений — ${messages}`;
});
